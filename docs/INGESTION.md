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
