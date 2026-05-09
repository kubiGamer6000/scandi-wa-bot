# Database schema

All tables live under the `wa` schema. Migrations are in
[`db/migrations/`](../db/migrations/), applied in numeric order. The
Drizzle definitions in [`src/db/schema.ts`](../src/db/schema.ts) mirror
them.

| Migration                         | Adds                                         |
| --------------------------------- | -------------------------------------------- |
| `0001_init_wa_schema.sql`         | Core message store: 15 tables + indexes.     |
| `0002_auth_state.sql`             | Postgres-backed Baileys auth: `auth_creds`, `auth_keys`. |
| `0003_media_queue.sql`            | Queue columns on `wa.media` (`next_attempt_at`, `lease_until`, `completed_at`, `size_bytes`, `content_type`, `gcs_url`, claim/lease indexes). |
| `0004_media_processing.sql`      | AI processing queue: `wa.media_processing` with claim/lease indexes, unique constraint on `(media_id, processor)`. |

Apply with:

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

## Conventions

- Every table has `account_id UUID NOT NULL REFERENCES wa.accounts(id) ON
  DELETE CASCADE` so the entire bot's data can be wiped by deleting one
  row. Composite primary keys begin with `account_id`.
- Timestamps are `TIMESTAMPTZ` and stored in UTC.
- `raw` / `raw_message` / `raw_envelope` JSONB columns hold the original
  Baileys payload for forensics. We extract a flat projection into typed
  columns alongside.
- Row-Level Security is enabled on every table. The bot connects with a
  privileged role that bypasses RLS; RLS is defense-in-depth in case the
  schema is ever exposed via PostgREST.
- Updated-at triggers (`wa.touch_updated_at`) keep mutation timestamps fresh.

## ER diagram (text)

```
                    ┌────────────────────┐
                    │    wa.accounts     │  one row per WA login
                    │  id (PK, UUID)     │  label is a stable identifier
                    └─────────┬──────────┘  (default: 'default')
                              │ 1:N (cascade)
                              ▼
            ┌──────────────────────────────────────┐
            │ wa.contacts        wa.lid_mappings   │
            │ wa.chats           wa.settings       │
            │ wa.labels          wa.sync_state     │
            │ wa.event_log       wa.auth_creds     │
            │                    wa.auth_keys      │
            └────────────────┬─────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
    ┌─────────────────┐ ┌──────────┐ ┌────────────────────────┐
    │   wa.chats      │ │wa.labels │ │ wa.label_associations  │
    │ (account, jid)  │ │          │ │ (label_id, chat, msg)  │
    └────────┬────────┘ └──────────┘ └────────────────────────┘
             │ 1:N
             ▼
   ┌──────────────────────┐
   │ wa.group_participants│
   └──────────────────────┘
             │ via (account_id, chat_jid)
             ▼
   ┌──────────────────────────────────────┐
   │            wa.messages               │
   │  (account_id, chat_jid, id) PK       │
   └──┬─────────┬─────────┬─────────┬─────┘
      │ 1:N     │ 1:N     │ 1:N     │ 1:N
      ▼         ▼         ▼         ▼
   ┌────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐
   │  edits │ │reactions │ │  media   │ │message_receipts │
   └────────┘ └──────────┘ └──────────┘ └─────────────────┘
```

## Tables

### `wa.accounts`

One row per linked WhatsApp account. Created on first boot via
`ensureAccount()` in `src/store/handlers/account.ts`. The
`config.waAccountLabel` (default `'default'`) is the stable lookup key.

| Column         | Type          | Notes                                                                                |
| -------------- | ------------- | ------------------------------------------------------------------------------------ |
| `id`           | `UUID PK`     | Generated default; referenced by every other `wa.*` table.                           |
| `label`        | `TEXT UNIQUE` | Stable identifier (`'default'`).                                                     |
| `self_pn_jid`  | `TEXT`        | Bot's own PN form, e.g. `447960451664:14@s.whatsapp.net`. Set on `connection.open`.  |
| `self_lid_jid` | `TEXT`        | Bot's own LID, e.g. `205321565942003:14@lid`. Set on `connection.open`.              |
| `push_name`    | `TEXT`        | Display name shown in WA's Linked Devices list.                                      |
| `paired_at`    | `TIMESTAMPTZ` |                                                                                      |
| `last_seen_at` | `TIMESTAMPTZ` |                                                                                      |
| `status`       | `TEXT`        | `active` / `logged_out` / `paused`. Flipped to `logged_out` on permanent disconnect. |
| `auth_dir`     | `TEXT`        | Path on disk where Baileys keeps the session.                                        |
| `created_at`   | `TIMESTAMPTZ` |                                                                                      |

### `wa.lid_mappings`

LID ↔ PN mappings observed via `lid-mapping.update` events and history
sync. Used by the renderer to map "Velislav (lid 187…)" back to a real
phone number and to merge fragmented DM history (see `RENDERER.md`).

| Column        | Type          | Notes                                  |
| ------------- | ------------- | -------------------------------------- |
| `account_id`  | `UUID FK`     |                                        |
| `lid`         | `TEXT`        | E.g. `187595850019032@lid`.            |
| `pn`          | `TEXT`        | E.g. `359884430293@s.whatsapp.net`.    |
| `observed_at` | `TIMESTAMPTZ` |                                        |
| **PK**        |               | `(account_id, lid)`                    |
| **Index**     |               | `(account_id, pn)`                     |

### `wa.contacts`

Result of `contacts.upsert`/`contacts.update` events plus history-sync
contact lists. Newer-data-wins merge; saved names never get nulled-out.

| Column          | Type          | Notes                                                          |
| --------------- | ------------- | -------------------------------------------------------------- |
| `account_id`    | `UUID FK`     |                                                                |
| `jid`           | `TEXT`        | Either PN form (`…@s.whatsapp.net`) or LID (`…@lid`).          |
| `pn`            | `TEXT`        | Phone-form JID, when known.                                    |
| `lid`           | `TEXT`        | LID form, when known.                                          |
| `name`          | `TEXT`        | The user's saved name (from your address book).                |
| `push_name`     | `TEXT`        | Notify name advertised by the contact.                         |
| `business_info` | `JSONB`       | `verifiedName` etc.                                            |
| `is_business`   | `BOOLEAN`     |                                                                |
| `raw`           | `JSONB`       | Last full Baileys `Contact` object.                            |
| `first_seen_at` | `TIMESTAMPTZ` |                                                                |
| `last_seen_at`  | `TIMESTAMPTZ` | Bumped on every upsert.                                        |
| **PK**          |               | `(account_id, jid)`                                            |
| **Indexes**     |               | partial on `pn` and `lid` (each WHERE NOT NULL)                |

### `wa.chats`

Every conversation we know about. `type` partitions them:

- `dm` – direct message, JID ends `@s.whatsapp.net`
- `group` – `@g.us`
- `lid` – LID-form chat, `@lid`
- `broadcast`, `newsletter`, `status`, `system` – self-explanatory

DMs in modern WhatsApp can have **two** rows (one `dm`, one `lid`) — the
PN-form chat carries old history-sync messages while the LID-form chat
receives live messages. The renderer merges both.

Notable columns:

| Column                | Type          | Notes                                                              |
| --------------------- | ------------- | ------------------------------------------------------------------ |
| `subject`             | `TEXT`        | Group name. NULL for DMs.                                          |
| `description`         | `TEXT`        | Group description.                                                 |
| `owner_jid`           | `TEXT`        | Group creator.                                                     |
| `pn_jid`              | `TEXT`        | For LID-form chats: the PN-form JID of the same conversation.      |
| `account_lid`         | `TEXT`        | The account's own LID as observed in this chat.                    |
| `unread_count`        | `INT`         |                                                                    |
| `archived`            | `BOOLEAN`     |                                                                    |
| `ephemeral_seconds`   | `INT`         | Disappearing-messages duration.                                    |
| `oldest_known_ts`     | `TIMESTAMPTZ` | History-sync watermark; we have messages back to (but not before). |
| `history_complete`    | `BOOLEAN`     | Set when WA reports there's no more history available.             |
| `cleared_at`          | `TIMESTAMPTZ` | Set by `chats.delete` (= "delete chat" / "clear messages").        |
| `raw`                 | `JSONB`       |                                                                    |
| **PK**                |               | `(account_id, jid)`                                                |
| **Indexes**           |               | `(account_id, conversation_ts DESC)`, `(account_id, type)`         |

### `wa.group_participants`

Group membership table. One row per `(group, member, role)` combination,
with `joined_at`/`left_at` markers. Updated by `groups.upsert`,
`groups.update`, and `group-participants.update`.

| Column           | Type          | Notes                                            |
| ---------------- | ------------- | ------------------------------------------------ |
| `account_id`     | `UUID FK`     |                                                  |
| `group_jid`      | `TEXT`        |                                                  |
| `participant`    | `TEXT`        | Group member's primary JID (LID in v7).          |
| `participant_pn` | `TEXT`        | Optional PN-form JID hint.                       |
| `role`           | `TEXT`        | `admin` / `superadmin` / NULL (regular member).  |
| `joined_at`      | `TIMESTAMPTZ` |                                                  |
| `left_at`        | `TIMESTAMPTZ` | Set on `remove`.                                 |
| **PK**           |               | `(account_id, group_jid, participant)`           |
| **FK**           |               | `(account_id, group_jid) → wa.chats(account_id, jid)` |

### `wa.messages`

The hot table. One row per WhatsApp message, identified by
`(account_id, chat_jid, id)`. **Crucial invariants:**

- `raw_message` is **nullable**. If a deletion arrives before the original
  (a "tombstone"), we still create a row.
- `raw_envelope` is always present (it's the cheap `WAMessageKey` + meta).
- `tombstone = TRUE` ⇔ we never observed the body.
- `deleted_at IS NOT NULL` ⇔ the message has been deleted (REVOKE,
  client-delete, or chat-wide clear). The `text`/`caption`/media may still
  be present in `raw_message` for forensic context.
- `is_protocol = TRUE` ⇔ this row carries a `protocolMessage` envelope
  (key rotation, history-sync notification, REVOKE, etc.). The renderer
  hides REVOKE rows by default since their effect is already shown via
  `deleted_at` on the target.

| Column                    | Type          | Notes                                                                |
| ------------------------- | ------------- | -------------------------------------------------------------------- |
| `chat_jid`                | `TEXT`        | The conversation this message belongs to.                            |
| `id`                      | `TEXT`        | WhatsApp's stanza ID (uppercase hex or `3EB0…`).                     |
| `from_me`                 | `BOOLEAN`     | True for messages the bot sent.                                      |
| `participant`             | `TEXT`        | Group sender JID. NULL for DMs.                                      |
| `sender_pn`               | `TEXT`        | `key.participantAlt` — alternate (PN) form of the sender.            |
| `remote_jid_alt`          | `TEXT`        | `key.remoteJidAlt` — alternate form of the chat JID.                 |
| `ts`                      | `TIMESTAMPTZ` | Server timestamp.                                                    |
| `status`                  | `TEXT`        | `pending` / `server_ack` / `delivery_ack` / `read` / `played`.       |
| `message_addressing_mode` | `TEXT`        | `lid` or `pn`.                                                       |
| `push_name`               | `TEXT`        | Sender's display name at time of send.                               |
| `broadcast`               | `BOOLEAN`     |                                                                      |
| `message_type`            | `TEXT`        | Top-level proto key, e.g. `extendedTextMessage`, `imageMessage`.     |
| `is_protocol`             | `BOOLEAN`     | True iff `protocolMessage` is the dominant content.                  |
| `text` / `caption`        | `TEXT`        | Extracted plaintext bodies (post-unwrap of ephemeral / viewOnce).    |
| `forwarded`               | `BOOLEAN`     | From `contextInfo.isForwarded`.                                      |
| `forward_score`           | `INT`         |                                                                      |
| `quoted_*`                | `TEXT`        | Reply target hints (`quotedMsgId`, `quotedParticipant`, `quotedText`). |
| `edit_count`              | `INT`         | Increments every time `messages.update` brings new content.          |
| `last_edited_at`          | `TIMESTAMPTZ` |                                                                      |
| `deleted_at`              | `TIMESTAMPTZ` | NULL → live message.                                                 |
| `deleted_by_jid`          | `TEXT`        | Who revoked it; NULL when self-revoke or unknown.                    |
| `deletion_reason`         | `TEXT`        | `sender_revoke` / `admin_revoke` / `client_delete`.                  |
| `tombstone`               | `BOOLEAN`     | TRUE ⇒ we never saw the body.                                        |
| `raw_message`             | `JSONB`       | Decoded `WAMessage.message`, Buffer-safe via BufferJSON.             |
| `raw_envelope`            | `JSONB`       | Everything in `WAMessage` except `.message`.                         |
| **PK**                    |               | `(account_id, chat_jid, id)`                                         |
| **FK**                    |               | `(account_id, chat_jid) → wa.chats(account_id, jid)`                 |
| **Indexes**               |               | chat-by-time, account-by-time, participant, quoted, **trigram on `text`**, alive-only by chat |

### `wa.message_edits`

Append-only history of prior versions. When `messages.update` brings new
content, the *previous* live row is snapshotted here before being
overwritten. The current version always lives on `wa.messages`.

| Column            | Type        | Notes                                                                |
| ----------------- | ----------- | -------------------------------------------------------------------- |
| `id`              | `BIGSERIAL` |                                                                      |
| `version`         | `INT`       | 1, 2, 3… in `messages.edit_count` order.                             |
| `text` / `caption`| `TEXT`      | Body of that prior version.                                          |
| `message_type`    | `TEXT`      |                                                                      |
| `raw_message`     | `JSONB`     | The full prior `proto.IMessage`.                                     |
| `observed_at`     | `TIMESTAMPTZ` | When *we* saw the edit; not when WA produced it.                   |
| **Unique**        |             | `(account_id, chat_jid, message_id, version)`                        |
| **FK**            |             | `(account_id, chat_jid, message_id) → wa.messages(...)` cascade.     |

### `wa.reactions`

Current state per `(message, actor)`. `emoji = NULL` means the reaction
was removed; we never delete the row so we keep the history of "they
*had* reacted".

| Column       | Type          | Notes                                                         |
| ------------ | ------------- | ------------------------------------------------------------- |
| `actor_jid`  | `TEXT`        | The reactor. May be `…@lid` or `…@s.whatsapp.net`.            |
| `emoji`      | `TEXT`        | The reaction text (`'❤️'`, etc.) or NULL when removed.        |
| `ts`         | `TIMESTAMPTZ` |                                                               |
| **PK**       |               | `(account_id, chat_jid, message_id, actor_jid)`               |
| **FK**       |               | `(account_id, chat_jid, message_id) → wa.messages(...)`       |

### `wa.media`

Per-message media metadata **and a Postgres-backed work queue for the
downloader**. Every row is created with `download_status='pending'` by
the message ingester and then walked through the state machine below by
[`MediaWorker`](../src/store/media/worker.ts). The full original raw
payload is preserved in `raw` JSONB so we can re-derive any field we
missed (or re-decrypt if WA refreshes the URL).

#### State machine

```
                         (worker claim)
   pending  ──────────────────────────────►  in_progress
     ▲                                            │
     │ retry (transient,                          │ download +
     │  with next_attempt_at                      │ upload OK
     │   exponential backoff)                     ▼
     │                                          done   ◄── terminal
     │                                            
     │ (lease expired,                          
     │  reaper sweep)                          
     │                                          
   in_progress ◄─── (worker crashed)             
     │                                            
     │  too_large / type_disabled / decrypted_too_large
     ├──────────────────────────────────────►  skipped ◄── terminal
     │                                            
     │  raw_message missing / non-transient       
     │  download error / max_attempts reached     
     └──────────────────────────────────────►  failed  ◄── terminal
```

#### Columns

| Column              | Type           | Notes                                                                 |
| ------------------- | -------------- | --------------------------------------------------------------------- |
| `media_type`        | `TEXT`         | `image` / `video` / `audio` / `document` / `sticker` / `ptv` / `gif`. |
| `mime_type`         | `TEXT`         | As declared in the WA proto.                                           |
| `file_name`         | `TEXT`         | For documents.                                                        |
| `file_length`       | `BIGINT`       | Encrypted-blob length from the WA proto. Used for early "too large" rejects. |
| `width`/`height`    | `INT`          |                                                                       |
| `duration_seconds`  | `INT`          | Audio, video.                                                         |
| `page_count`        | `INT`          | Documents.                                                            |
| `media_key`         | `BYTEA`        | AES key needed to decrypt the blob. Treat as secret.                  |
| `file_sha256`       | `BYTEA`        |                                                                       |
| `file_enc_sha256`   | `BYTEA`        |                                                                       |
| `direct_path`/`url` | `TEXT`         | What you'd hand to `downloadMediaMessage`.                            |
| `thumbnail`         | `BYTEA`        | Inline preview blob.                                                  |
| `jpeg_thumbnail`    | `BYTEA`        | Smaller JPEG preview, when available.                                 |
| `caption`           | `TEXT`         |                                                                       |
| `download_status`   | `TEXT`         | `pending` / `in_progress` / `done` / `failed` / `skipped`. See state machine above. |
| `download_error`    | `TEXT`         | Last failure reason (truncated to 500 chars).                         |
| `download_attempts` | `INT`          | Incremented atomically when the worker claims the row.                |
| `next_attempt_at`   | `TIMESTAMPTZ`  | When the row is eligible for the next claim (NOW() initially; bumped on transient failure with exponential backoff: 30s → 2m → 10m → 1h → 6h → 24h). |
| `lease_until`       | `TIMESTAMPTZ`  | Set at claim time to NOW() + `MEDIA_LEASE_SECONDS`. NULL otherwise. The reaper restores rows whose lease expired. |
| `worker_id`         | `TEXT`         | `<hostname>-<pid>` of the holder. Debug aid.                          |
| `completed_at`      | `TIMESTAMPTZ`  | When `download_status` went to `done`.                                |
| `size_bytes`        | `BIGINT`       | Verified post-download size. May differ from `file_length` (which is the encrypted-blob size). |
| `content_type`      | `TEXT`         | Final content-type used when uploading the storage object.            |
| `gcs_bucket`        | `TEXT`         | Set when `done`.                                                      |
| `gcs_object`        | `TEXT`         | Object key inside the bucket. Pattern: `accounts/<accountId>/<chatJidSafe>/<messageId>.<ext>`. |
| `gcs_url`           | `TEXT`         | Token-bearing public download URL from `getDownloadURL()`. Optional — the (bucket, object) pair is canonical. |
| `local_path`        | `TEXT`         | Optional debug-only local path. Reserved for future `LocalDiskStorage`. |
| `is_voice_note`     | `BOOLEAN`      | True when audio is a PTT.                                             |
| `waveform`          | `BYTEA`        |                                                                       |
| `raw`               | `JSONB`        | Full nested message payload.                                          |
| **Unique**          |                | `(account_id, chat_jid, message_id)`                                  |
| **Indexes**         |                | `media_ready_idx (next_attempt_at, account_id) WHERE status='pending'` (claim driver), `media_lease_expired_idx (lease_until) WHERE status='in_progress'` (reaper). |

### `wa.media_processing`

AI processing queue. Each row represents a single AI analysis job
(video description, audio transcription, image description, or document
parsing). Created automatically when `wa.media` reaches `download_status='done'`.

Same `FOR UPDATE SKIP LOCKED` queue pattern as `wa.media`, with longer
leases (10 min default) since AI calls are slower.

| Column          | Type           | Notes                                                                 |
| --------------- | -------------- | --------------------------------------------------------------------- |
| `processor`     | `TEXT`         | `gemini_video`, `gemini_image`, `elevenlabs_audio`, `llamaparse_document`. |
| `model`         | `TEXT`         | e.g. `gemini-2.5-flash`, `scribe_v2`, `agentic`.                     |
| `prompt`        | `TEXT`         | The prompt sent to the AI (NULL for audio/document).                  |
| `gcs_bucket`    | `TEXT`         | Denormalized from `wa.media` for the claim query.                    |
| `gcs_object`    | `TEXT`         | Object key in Firebase Storage.                                       |
| `status`        | `TEXT`         | `pending` / `in_progress` / `done` / `failed`.                       |
| `error`         | `TEXT`         | Last failure reason.                                                  |
| `attempts`      | `INT`          | Incremented at claim. Backoff: 1m, 5m, 30m, 2h.                     |
| `result_text`   | `TEXT`         | The AI output: transcript, description markdown, or parsed markdown.  |
| `result_meta`   | `JSONB`        | Token counts, model version, page count, language, etc.              |
| `processing_ms` | `INT`          | Wall-clock time of the AI call.                                       |
| **Unique**      |                | `(media_id, processor)` — prevents duplicate jobs.                   |
| **Indexes**     |                | `media_processing_ready_idx`, `media_processing_lease_idx`, `media_processing_media_idx`. |

### `wa.message_receipts`

Per-recipient ACKs (delivery, read, play). Useful for groups. One row per
`(message, user, type)`.

### `wa.labels` and `wa.label_associations`

WhatsApp Business labels. `label_associations.message_id` defaults to `''`
so the unique key works for chat-level associations (no specific message).

### `wa.settings`

Key-value bag for app-state settings (push-name, ephemeral defaults, app-state
collections). Set by `settings.update`.

### `wa.sync_state`

Per-account watermark of history sync progress.

| Column                 | Type          | Notes                                                                 |
| ---------------------- | ------------- | --------------------------------------------------------------------- |
| `history_received_at`  | `TIMESTAMPTZ` |                                                                       |
| `history_progress_pct` | `INT`         | 0–100, set on each `messaging-history.set`.                           |
| `history_chunk_order`  | `TEXT`        |                                                                       |
| `history_sync_type`    | `TEXT`        | `INITIAL_BOOTSTRAP` / `RECENT` / `FULL` / etc.                        |
| `is_latest`            | `BOOLEAN`     |                                                                       |
| `initial_sync_done`    | `BOOLEAN`     | Flipped TRUE on `messaging-history.status` with `status: 'complete'`. |
| `last_event_at`        | `TIMESTAMPTZ` |                                                                       |

### `wa.event_log`

Append-only catchall for unmodeled / debug Baileys events
(`blocklist.set`, `call`, `newsletter.*`, etc.). We keep them as JSONB so
forensic queries are possible. Truncate freely.

### `wa.auth_creds`

Singleton table holding the current `AuthenticationCreds` blob (Baileys
session credentials) for each account. Updated every time Baileys emits
`creds.update`. Bytes round-trip through `BufferJSON.replacer` so the
JSONB shape matches what the file-based reference impl writes
(`{"type":"Buffer","data":"<base64>"}`).

| Column       | Type          | Notes                                  |
| ------------ | ------------- | -------------------------------------- |
| `account_id` | `UUID PK FK`  | One row per account.                   |
| `creds`      | `JSONB`       | The full `AuthenticationCreds` object. |
| `updated_at` | `TIMESTAMPTZ` |                                        |

### `wa.auth_keys`

Signal protocol keys. One row per `(account, type, id)`. Read/written
in bulk by the auth handler.

`type` is one of:

- `pre-key` (numeric IDs, ~800 of them)
- `session` (one per `<jid>:<deviceId>`)
- `sender-key` (group senders)
- `sender-key-memory` (per-jid sent-already flags)
- `app-state-sync-key` (re-hydrated to proto class on read)
- `app-state-sync-version` (LT-Hash state per app-state collection)
- `lid-mapping` (LID ↔ PN cache)
- `device-list` (device IDs per JID)
- `tctoken` (third-party-cookie tokens for WA-Web)
- `identity-key`

| Column       | Type          | Notes                                                                |
| ------------ | ------------- | -------------------------------------------------------------------- |
| `account_id` | `UUID FK`     |                                                                      |
| `type`       | `TEXT`        | Member of `SignalDataTypeMap`.                                       |
| `id`         | `TEXT`        | Original Baileys key id (e.g. `447960451664@s.whatsapp.net:14`).     |
| `value`      | `JSONB`       | BufferJSON-encoded.                                                  |
| `updated_at` | `TIMESTAMPTZ` |                                                                      |
| **PK**       |               | `(account_id, type, id)`                                             |
| **Index**    |               | `(account_id, type)` — supports bulk SELECT by type.                 |

### Treating auth as secret

Both `auth_creds.creds` and `auth_keys.value` contain raw private keys
(noiseKey, identityKey, signedPreKey…). Anyone with read access can
impersonate the account on WhatsApp. Lock down your DB role accordingly:
RLS is on by default; the bot connects with a privileged role that
bypasses it. Never expose these tables via PostgREST.

## Indexes worth knowing about

- `messages_chat_ts_idx (account_id, chat_jid, ts DESC)` — primary access
  pattern for the renderer.
- `messages_alive_idx (account_id, chat_jid, ts DESC) WHERE deleted_at IS
  NULL` — partial index for "current view of a chat" queries.
- `messages_text_trgm_idx GIN (text gin_trgm_ops) WHERE text IS NOT NULL`
  — fuzzy search will go here.
- `messages_quoted_idx (account_id, chat_jid, quoted_msg_id)` — fast
  reply-graph traversal.
- `media_pending_idx (download_status, inserted_at) WHERE download_status
  IN ('pending', 'failed')` — backlog query for the future downloader.

## Triggers

`wa.touch_updated_at()` is attached to `chats`, `messages`, `media`,
`labels`, `settings`, `sync_state` so `updated_at` always reflects the
latest write without callers having to remember.

## What we deliberately DO NOT store separately

- **Reaction history.** Only the *current* reaction state per
  `(message, actor)` is kept. Adding a history table is straightforward
  if needed later — no schema change is forced today.
- **Read receipts beyond per-user-per-type.** We don't model "delivered
  to all" aggregates; a query can compute that.
- **Per-chat membership history before the bot was paired.** That's
  beyond what WhatsApp gives us.
