# Ingestion

This doc explains how Baileys events become rows in `wa.*`. Read
[`SCHEMA.md`](SCHEMA.md) first for the table layout.

The store is a single class, `ChatStore` ([`src/store/index.ts`](../src/store/index.ts)),
that subscribes to every event we care about and dispatches to a
per-concern handler in `src/store/handlers/`.

## Design tenets

1. **Idempotent everywhere.** Every handler uses `INSERT … ON CONFLICT DO
   UPDATE` so re-receiving a chunk (history-sync overlap, reconnect
   replay) is a no-op or a strict refinement. Newer non-null fields win;
   we never overwrite a known value with NULL.
2. **Tombstones first.** If a delete arrives before the original message,
   we still create the row. The body backfills later from history sync.
3. **Raw payloads preserved.** `raw_message` / `raw_envelope` / `raw`
   JSONB columns hold the unmodified Baileys payload (with Buffers
   serialized via `BufferJSON`). Anything we don't extract today can be
   re-derived later without a re-sync.
4. **Single-account context per call.** Every handler receives a
   `StoreContext` (`accountId`, `db`, `log`). Multi-account support is a
   matter of constructing different stores.
5. **Errors don't crash the bot.** Each `ev.on(...)` callback is wrapped
   in `run(label, fn)` which catches and logs. A failed handler doesn't
   tear down the socket.

## Event → handler map

| Baileys event                  | Handler (file)                                | Tables touched                                |
| ------------------------------ | --------------------------------------------- | --------------------------------------------- |
| `creds.update`                 | `auth.saveCreds` (in `src/auth.ts`)           | `wa.auth_creds`                               |
| `connection.update`            | `account.updateAccountIdentity` + `invalidateSelfCache` | `wa.accounts`                       |
| `lid-mapping.update`           | `lid.upsertLidMappings`                       | `wa.lid_mappings`                             |
| `contacts.upsert`/`.update`    | `contacts.upsertContacts`                     | `wa.contacts`                                 |
| `chats.upsert`/`.update`       | `chats.upsertChats`                           | `wa.chats`                                    |
| `chats.delete`                 | `chats.markChatCleared`                       | `wa.chats(cleared_at)`                        |
| `messaging-history.set`        | `history.handleHistorySet`                    | many — see below                              |
| `messaging-history.status`     | `history.handleHistoryStatus`                 | `wa.sync_state(initial_sync_done)`            |
| `messages.upsert`              | `messages.upsertMessages` (+ inline reaction/REVOKE routing) | `wa.messages`, `wa.media`, `wa.reactions`, deletion fields |
| `messages.update`              | `messages.handleMessageUpdates`               | `wa.messages`, `wa.message_edits`             |
| `messages.delete`              | `messages.handleMessageDeletes`               | `wa.messages(deleted_at)`                     |
| `messages.reaction`            | `reactions.handleReactions`                   | `wa.reactions` (legacy path; modern WA uses inline) |
| `message-receipt.update`       | `misc.recordReceipts`                         | `wa.message_receipts`                         |
| `groups.upsert`/`.update`      | `groups.upsertGroups`                         | `wa.chats`, `wa.group_participants`           |
| `group-participants.update`    | `groups.handleGroupParticipantsUpdate`        | `wa.group_participants`                       |
| `labels.edit`                  | `misc.upsertLabel`                            | `wa.labels`                                   |
| `labels.association`           | `misc.upsertLabelAssociation`                 | `wa.label_associations`                       |
| `settings.update`              | `misc.updateSetting`                          | `wa.settings`                                 |
| Anything unmodeled             | `misc.logEvent`                               | `wa.event_log`                                |

## History sync (`messaging-history.set`)

After pair, WhatsApp streams the historical chats and messages in chunks.
A single chunk (`HistoryPayload`) has up to four arrays:

- `lidPnMappings` — LID ↔ PN mappings discovered along the way.
- `contacts` — contact rows.
- `chats` — chat rows, each with an inline `messages[]` carrying *that
  chat's recent messages*.
- `messages` — top-level batch of messages for various chats.

`handleHistorySet`:

1. Upserts mappings → `wa.lid_mappings`.
2. Upserts contacts → `wa.contacts`.
3. Upserts chats → `wa.chats`.
4. **Deduplicates** the inline `chats[].messages[]` against the
   top-level `messages[]` using `{remoteJid, id, fromMe}` as the key,
   then upserts the union → `wa.messages` (and `wa.media` where
   applicable).
5. Updates `wa.sync_state` with chunk progress, type, and order.

Re-running the same chunk is a no-op because every upsert uses
`COALESCE(existing, EXCLUDED.…)` to preserve already-known fields.
Tombstones get backfilled when their bodies finally arrive.

`messaging-history.status` flips `initial_sync_done` once WA reports
`status: 'complete'`. This is the signal to start any one-shot post-sync
work (none yet).

## Real-time messages (`messages.upsert`)

The hot path. For each `WAMessage`:

1. Reject obvious noise: missing `chatJid`/`id`, non-ingestible JIDs.
2. **Unwrap envelope** in `extract.ts` — peel off `ephemeralMessage`,
   `viewOnceMessage*`, `editedMessage`, etc. to find the real content.
3. Project to flat columns:
   - `messageType` = first non-`messageContextInfo` content key.
   - `text` / `caption` / `quoted*` / `forwarded*`.
4. Pre-emit a `wa.media` row if any media payload is present.
5. **REVOKE detection.** If `protocolMessage.type` is `REVOKE` (numeric
   enum from live events, or string `'REVOKE'` from JSONB-revived
   history), schedule a tombstone on the **outer** chat (see "REVOKE
   gotcha" below).
6. **Reaction detection.** If `reactionMessage` is present, route it to
   `recordInlineReaction` so it becomes a `wa.reactions` row instead of
   a misclassified message (see "Reaction gotcha" below).
7. Bulk insert via `INSERT … ON CONFLICT DO UPDATE`. The conflict resolution
   pattern:

   ```sql
   text             = COALESCE(messages.text, EXCLUDED.text)         -- never null-overwrite
   raw_message      = COALESCE(messages.raw_message, EXCLUDED.raw_message)  -- backfill tombstones
   ts               = LEAST(EXCLUDED.ts, messages.ts)                -- earliest known wins
   status           = COALESCE(EXCLUDED.status, messages.status)     -- newer status wins
   is_protocol      = messages.is_protocol OR EXCLUDED.is_protocol
   ```

8. Update the LRU cache (`MessageCache`) so `getMessage` doesn't have to
   round-trip the DB on the next retry.
9. Apply revokes / inline reactions one-by-one (sequential to keep the
   `applyRevoke` and `recordInlineReaction` semantics simple).

## Edits (`messages.update`)

A `WAMessageUpdate` arrives any time:
- WhatsApp updates a status (delivery_ack, read, played).
- Someone edits a message (only certain text-message types are editable).

For each update:

1. Load the existing row by `(account_id, chat_jid, id)`.
2. If `update.message` is non-null and we already had `raw_message`:
   - Project both old and new bodies via `extract.ts`.
   - If `text` / `caption` / `messageType` differ → snapshot the *old*
     row into `wa.message_edits` with `version = edit_count + 1`, then
     overwrite the live row with the new content and bump `edit_count`,
     `last_edited_at`.
3. If `update.status` is set, persist the string form.

Because we snapshot *before* overwriting, the live row always reflects
the latest version and `wa.message_edits` is a strict history.

## Deletions

Three orthogonal sources:

### `protocolMessage.type = REVOKE`
Sent through `messages.upsert`. Pattern: someone tapped "delete for
everyone".

**Gotcha (fixed):** The inner `protocolMessage.key.remoteJid` is encoded
from the *sender's* perspective. In a DM, when the contact revokes their
message, that inner `remoteJid` is the **bot's own LID** (because to the
contact, that *was* the chat). Using the inner `remoteJid` as the
deletion target was wrong; it tombstoned messages in a phantom self-LID
chat. The handler now uses the **outer** envelope's `chatJid` as the
deletion target, which is always the conversation we received the REVOKE
in.

`applyRevoke` upserts a row with `tombstone = TRUE` and `deleted_at = NOW()`.
If the original was already in the table, it stays (we just set
`deleted_at`). If not, the tombstone row will be backfilled on the next
history-sync pass.

### `messages.delete`
Two shapes:
- `{ keys: WAMessageKey[] }` — explicit "delete for me" of specific
  messages.
- `{ jid: string, all: true }` — "clear chat" / "delete chat".

Both produce `deleted_at` updates with `deletion_reason = 'client_delete'`.

### `chats.delete`
Sets `wa.chats.cleared_at`. The messages remain in `wa.messages` so the
audit trail is preserved.

## Reactions

**Modern path (the usual one).** WhatsApp emits reactions as ordinary
`messages.upsert` payloads carrying a `reactionMessage` body. The store
detects this in `prepareMessage` via `extractReaction`, then routes it to
`recordInlineReaction` (`src/store/handlers/reactions.ts`):

1. Resolve the actor JID:
   - Group: outer `key.participant`.
   - DM, `fromMe = false`: the chat counterpart (`outer chatJid`).
   - DM, `fromMe = true`: the bot's own self JID (PN or LID, picked to
     match the chat's addressing mode).
2. Upsert into `wa.reactions` with conflict key `(account, chat,
   message, actor)`. Newer `ts` wins.

**Legacy path.** The `messages.reaction` handler still exists and still
ingests the same shape, in case a future Baileys release reverts to that
event.

`emoji = NULL` means the reaction was removed. We never delete the row,
so the historical "they once had ❤️" is preserved.

### `messageContextInfo` mis-classification (fixed)
The decoder sometimes surfaces `messageContextInfo` as the first object
key, even when the row carries a real `reactionMessage` /
`protocolMessage` body. `messageTypeOf` now skips
`messageContextInfo` when picking the dominant type, only keeping it if
it's the *only* key present.

## Self-cache (per-account self JID)

`recordInlineReaction` needs to know the bot's own JID for `fromMe`
reactions. We cache `(self_pn_jid, self_lid_jid)` per account at first
use (lazy), and `invalidateSelfCache(accountId)` is called from
`connection.update` (open) so re-pairing rotates it correctly.

## Groups

- `groups.upsert` / `groups.update` → upserts the `wa.chats` row (with
  `type = 'group'`) AND `wa.group_participants` rows. Empty-string
  `participant` JIDs are normalized to NULL.
- `group-participants.update` (`{action: 'add'|'remove'|'promote'|
  'demote'|'modify', participants}`) updates membership and roles.
  `remove` sets `left_at`.

## What goes in `event_log`

The catchall handler (`misc.logEvent`) writes a row for every event we
don't model: `blocklist.set`, `blocklist.update`, `call`,
`message-capping.update`, `newsletter.*`, `group.join-request`,
`group.member-tag.update`, `chats.lock`. Truncate freely.

## Media pipeline (download → upload → persist)

Every media-bearing message creates a `wa.media` row at ingestion with
`download_status='pending'` (just metadata; bytes have not been touched
yet). A long-running [`MediaWorker`](../src/store/media/worker.ts) drains
that queue:

```
messages.upsert ─┐
                 │ insert wa.media (status='pending')
history sync ────┘
                 │
                 ▼
         ChatStore.notify() ───► MediaWorker.notify() (wakes idle poll)
                                          │
                                          ▼
       claim batch via FOR UPDATE SKIP LOCKED  (status pending → in_progress)
                                          │
                                          ▼
       SELECT raw_envelope, raw_message FROM wa.messages   (rebuild WAMessage)
                                          │
                                          ▼
            downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest })
                                          │
                                          ▼
                 Firebase Storage:  bucket.file(key).save(buffer)
                                          │
                                          ▼
                  UPDATE wa.media SET status='done', gcs_*, size_bytes, content_type
```

### Why a Postgres queue and not Cloud Tasks / SQS / a separate broker?

For a single-process bot, the queue's three jobs are: durability, retry,
throttling. Postgres already gives us all three:

- **Durable.** Rows live in the same DB as the message they reference;
  no separate broker can drift out of sync.
- **Atomic claim.** `UPDATE wa.media … FROM (SELECT … FOR UPDATE SKIP
  LOCKED) AS ready` lets multiple workers (now or later) cooperate without
  any explicit locking code.
- **Backoff for free.** The next-attempt timestamp is just a column. No
  delay queues, no DLQs, no extra infrastructure.
- **Crash recovery.** Each claim stamps a `lease_until`; the worker
  reaper sweeps expired leases at the start of every poll cycle and
  resets them to `pending`.

This pattern scales to **thousands of jobs/second** before lock contention
becomes the bottleneck — orders of magnitude beyond what a WhatsApp bot
will ever produce. If we ever cross that threshold, the same code adopts
multiple workers transparently because of `SKIP LOCKED`.

### Worker tuning knobs

All sourced from env (see `.env.example`):

| Setting                       | Default   | What it controls                                                       |
| ----------------------------- | --------- | ---------------------------------------------------------------------- |
| `MEDIA_DOWNLOAD_CONCURRENCY`  | 3         | Parallel `downloadOne()` calls. Bound by `p-limit`.                    |
| `MEDIA_DOWNLOAD_BATCH_SIZE`   | 10        | Rows claimed per poll cycle.                                           |
| `MEDIA_DOWNLOAD_POLL_MS`      | 5000      | Idle wait between polls. Worker also wakes immediately on `notify()`.  |
| `MEDIA_LEASE_SECONDS`         | 120       | Time a claimed row stays in `in_progress` before reaper takes over.    |
| `MEDIA_MAX_ATTEMPTS`          | 6         | Hard cap on retries before a row is marked `failed`.                   |
| `MEDIA_MAX_BYTES`             | 100 MiB   | Pre-flight size guard. Larger media is `skipped`.                      |
| `MEDIA_TYPES`                 | all 7     | Allow-list of types (`image,video,audio,document,sticker,ptv,gif`).    |

### Failure modes and what they do

| Symptom                              | Outcome              |
| ------------------------------------ | -------------------- |
| `downloadMediaMessage` 404/410       | Baileys auto-calls `reuploadRequest` (`sock.updateMediaMessage`); on success the download proceeds, on persistent failure → transient retry. |
| Network/TLS error                    | Treated as transient (matched against patterns in `downloader.ts`). Backoff + retry. |
| Crypto/decode error                  | Non-transient → row marked `failed` immediately.                       |
| `raw_message` missing in DB          | Non-transient → `failed` (we can never decrypt without it).            |
| `file_length` > `MEDIA_MAX_BYTES`    | `skipped` (pre-download).                                              |
| Decrypted bytes > `MEDIA_MAX_BYTES`  | `skipped` (post-download).                                             |
| Storage `noop` (no bucket configured) | Worker idles, never claims. Rows stay `pending`. Set `FIREBASE_STORAGE_BUCKET` and restart. |
| Worker crashes mid-job               | Lease expires after `MEDIA_LEASE_SECONDS`; reaper resets row to `pending` on next poll. |

### Object key layout

```
accounts/{accountId}/{chatJidSafe}/{messageId}.{ext}
```

- `accountId` — UUID from `wa.accounts.id` (multi-tenant safe).
- `chatJidSafe` — JID with `@`, `:`, `/` replaced by `_`.
- `messageId` — original WA message id (already URL-safe).
- `ext` — derived from `mime_type` via a static map; falls back to a
  per-`media_type` default (`jpg`, `mp4`, `ogg`, …).

Idempotent: re-running a download for the same message overwrites the
same path, never accumulating duplicates. The pair `(gcs_bucket,
gcs_object)` is the canonical handle; `gcs_url` is just a convenience
token-bearing URL from `getDownloadURL()` for clients that want to embed
or share the file.

### Operational queries

```sql
-- queue depth
SELECT download_status, count(*) FROM wa.media GROUP BY 1;

-- what's stuck
SELECT id, chat_jid, message_id, media_type, download_attempts,
       download_error, next_attempt_at
FROM wa.media
WHERE download_status = 'pending' AND next_attempt_at > NOW()
ORDER BY next_attempt_at LIMIT 20;

-- biggest uploads in the last day
SELECT media_type, mime_type, size_bytes, gcs_object
FROM wa.media
WHERE download_status='done' AND completed_at > NOW() - interval '1 day'
ORDER BY size_bytes DESC LIMIT 10;

-- force-retry every failed row
UPDATE wa.media
SET download_status='pending', download_attempts=0,
    next_attempt_at=NOW(), download_error=NULL
WHERE download_status='failed';
```

## AI processing pipeline (post-download)

After `downloadOne` marks a media row as `done`, it calls
`enqueueProcessing()` which routes the media to an AI service based on
`media_type`:

| `media_type`          | Processor              | Model             | Input method          |
| --------------------- | ---------------------- | ----------------- | --------------------- |
| `video`, `ptv`, `gif` | `gemini_video`         | `gemini-2.5-flash` | `gs://` URI (zero I/O) |
| `image`, `sticker`    | `gemini_image`         | `gemini-2.5-flash` | `gs://` URI (zero I/O) |
| `audio`               | `elevenlabs_audio`     | `scribe_v2`       | Buffer download + upload |
| `document`            | `llamaparse_document`  | `agentic` tier    | Buffer download + upload |

The `ProcessingWorker` (same `FOR UPDATE SKIP LOCKED` pattern) claims
jobs from `wa.media_processing` and routes to the appropriate handler in
`src/store/processing/processors/`.

### Key design points

- **GCS URI passthrough for Gemini.** Videos and images are already in
  Firebase Storage (= GCS). We pass `gs://{bucket}/{object}` directly as
  `fileData.fileUri` — zero re-download, handles files up to 2 GB.
- **Buffer download for ElevenLabs/LlamaParse.** These APIs need the
  bytes uploaded. `MediaStorage.download(object)` fetches from GCS.
- **Customizable prompts.** Defaults in `src/store/processing/prompts.ts`,
  overridable via `PROCESSING_PROMPT_VIDEO` / `PROCESSING_PROMPT_IMAGE`.
- **Longer leases.** AI processing is slow (10-min default lease vs 2-min
  for downloads). Backoff schedule: 1m → 5m → 30m → 2h.
- **Unique constraint** `(media_id, processor)` prevents duplicate jobs.

### Operational queries

```sql
-- processing queue depth
SELECT processor, status, count(*) FROM wa.media_processing GROUP BY 1, 2 ORDER BY 1, 2;

-- recent completions with timing
SELECT processor, model, processing_ms, length(result_text) AS chars,
       completed_at
FROM wa.media_processing
WHERE status = 'done'
ORDER BY completed_at DESC LIMIT 20;

-- retry all failed processing
UPDATE wa.media_processing
SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
    error = NULL, lease_until = NULL, worker_id = NULL
WHERE status = 'failed';
```

## getMessage hot path

Baileys calls `getMessage(key)` to:
- Resend lost messages.
- Decrypt poll-vote payloads (which need the original poll question).

Implementation in `ChatStore.getMessage`:

1. LRU lookup (`MessageCache` keyed by `chat:id`). 2k entries by default.
2. On miss: `SELECT raw_message FROM wa.messages WHERE … LIMIT 1`.
3. Revive Buffers via `BufferJSON.reviver` and cache the decoded
   `proto.IMessage`.

## Backfills you can run safely

Useful one-shots when the schema/handler logic changes (the SQL examples
in this section are intentionally idempotent):

- **Migrate inline-`reactionMessage` rows into `wa.reactions`.** Run when
  upgrading from a build that didn't route reactions inline.
- **Re-tombstone REVOKEs in the correct outer chat.** Run when upgrading
  from a build that used the inner `protocolMessage.key.remoteJid`.

The exact SQL for both is recorded in the change log of the conversation
that introduced these fixes; see [`OPERATIONS.md`](OPERATIONS.md) for a
runnable copy.

## Logging

Every handler logs at `debug` with a structured payload (counts, IDs,
tags). At `info` we log:
- One line per `messaging-history.set` chunk with progress.
- "history sync complete" once.
- `connection opened` with `me` / `lid` / `name`.
- Reconnect attempts with delay.

Set `LOG_LEVEL=debug` in `.env` to see per-event chatter while tuning.
