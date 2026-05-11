# Architecture

## Process model

A single Node.js process owns:

- One **WhatsApp socket** (`Bot` in `src/bot.ts`), reconnecting on transient
  drops and exiting cleanly on permanent logout.
- One **PostgreSQL pool** via `postgres-js` + Drizzle ORM (`src/db/client.ts`).
- One **`ChatStore`** (`src/store/index.ts`) that subscribes to every Baileys
  event and writes through to the DB.
- One **in-memory LRU `MessageCache`** (`src/store/cache.ts`) to satisfy
  Baileys' `getMessage` config without hitting the DB on every retry/poll.
- One **`MediaWorker`** (`src/store/media/worker.ts`) that drains the
  `wa.media` queue (Postgres `FOR UPDATE SKIP LOCKED`) → `downloadMediaMessage`
  → Firebase Storage. Independent of the socket lifecycle; reconnects
  do not interrupt in-flight uploads.
- One **`ProcessingWorker`** (`src/store/processing/worker.ts`) that
  drains `wa.media_processing` and routes media to Gemini / ElevenLabs /
  LlamaParse for AI text projections.
- One **`MessageBus`** (`src/store/bus.ts`) — typed pub/sub for message
  lifecycle events (`received`, `edited`, `deleted`, `reacted`,
  `processed`). The webhook layer is the only consumer today.
- One **Fastify HTTP API** (`src/api/server.ts`) listening on `127.0.0.1`
  by default — exposes chat / message reads, send / react / edit / delete,
  webhook CRUD, and media fetch. Bearer-auth via `API_AUTH_TOKEN`.
- One **`WebhookWorker`** (`src/webhooks/worker.ts`) draining the third
  Postgres queue (`wa.webhook_deliveries`) with the same FOR UPDATE SKIP
  LOCKED pattern; POSTs HMAC-signed events to subscribed URLs with
  exponential-backoff retries. The enqueuer (`src/webhooks/enqueue.ts`)
  is a `MessageBus` listener that fans out events to active subscriptions.

```
                                   ┌───────────────────────────────┐
                                   │        WhatsApp servers       │
                                   └──────────────┬────────────────┘
                                                  │  Web protocol (TLS)
                                                  ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │                              Bot process                                │
   │                                                                         │
   │  ┌─────────────┐    QR / pairing-code        ┌────────────────────────┐ │
   │  │  src/bot.ts │ ◀──────────────────────────▶│  Baileys WASocket       │ │
   │  │             │                              │  + creds.update         │ │
   │  │  reconnect  │                              │  + connection.update    │ │
   │  │  loop       │                              │  + 20+ event streams    │ │
   │  └──────┬──────┘                              └──────────┬─────────────┘ │
   │         │                                                │ ev.on(...)   │
   │         │ start()                                        ▼              │
   │         ▼                                       ┌─────────────────────┐ │
   │  ┌─────────────┐                                │  src/store/         │ │
   │  │   Bot.ev    │                                │   ChatStore.bind()  │ │
   │  │ "messages.  │                                │                     │ │
   │  │  upsert"    │                                │ idempotent upserts  │ │
   │  └──────┬──────┘                                │ per-event handlers  │ │
   │         │                                       └──────────┬──────────┘ │
   │         ▼                                                  │            │
   │  ┌──────────────────┐                                      │            │
   │  │ handlers/        │                                      │            │
   │  │ messages.ts      │── Hello World quote-reply            │            │
   │  └──────────────────┘                                      │            │
   │                                                            │            │
   │  ┌──────────────────┐   getMessage(key)                   │            │
   │  │ MessageCache LRU │ ◀──────────────────────              │            │
   │  └──────────────────┘                                      ▼            │
   │                                                  ┌─────────────────────┐│
   │                                                  │    postgres-js      ││
   │                                                  │   pool (Drizzle)    ││
   │                                                  └──────────┬──────────┘│
   └─────────────────────────────────────────────────────────────┼───────────┘
                                                                 ▼
                                                       ┌──────────────────┐
                                                       │  Postgres `wa.*` │
                                                       │   (Supabase)     │
                                                       └──────────────────┘
```

## Component map

| Layer                  | File(s)                            | Responsibility                                                                                       |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Entry**              | `src/index.ts`                     | Verify DB, instantiate `Bot`, register SIGINT/SIGTERM, close DB on exit.                             |
| **Configuration**      | `src/config.ts`                    | `dotenv` + typed env parsing. Hard-fails on missing `DATABASE_URL`.                                  |
| **Logging**            | `src/logger.ts`                    | Root pino logger; `childLogger(name)` factory used everywhere.                                       |
| **Auth state**         | `src/auth.ts`                      | Postgres-backed `AuthenticationState` (`wa.auth_creds`, `wa.auth_keys`) wrapped with `makeCacheableSignalKeyStore`. Auto-imports any legacy `data/auth/` folder once. |
| **Socket lifecycle**   | `src/bot.ts`                       | QR pairing, reconnect backoff, group-metadata cache, `loggedOut` cleanup.                            |
| **DB client**          | `src/db/client.ts`                 | `postgres-js` pool, IPv4 DNS pre-resolution (Supabase IPv6 workaround), pooler-aware `prepare` flag. |
| **DB schema**          | `src/db/schema.ts`                 | Drizzle schema mirroring the SQL migration. Source of truth for typed queries.                       |
| **Store facade**       | `src/store/index.ts`               | `ChatStore` class. `bind(sock)` wires every Baileys event to a handler.                              |
| **Store handlers**     | `src/store/handlers/*.ts`          | One file per concern: account, contacts, chats, groups, messages, history, reactions, lid, misc.    |
| **Extraction helpers** | `src/store/extract.ts`             | Pure functions that project Baileys protos into flat DB rows.                                        |
| **JID utilities**      | `src/store/jids.ts`                | `classifyJid` (DM / group / lid / etc.) and ingest filters.                                          |
| **Serialization**      | `src/store/serialize.ts`           | Buffer → base64 round-trip for `JSONB` columns.                                                      |
| **Media storage**      | `src/store/media/storage.ts`       | `MediaStorage` interface + `FirebaseStorage` (uses `firebase-admin/storage` `bucket.file().save()`) + `NoopStorage`. |
| **Media downloader**   | `src/store/media/downloader.ts`    | One-shot per-row pipeline: rebuild `WAMessage` from DB → `downloadMediaMessage` → `storage.put` → mark `done`. |
| **Media worker**       | `src/store/media/worker.ts`        | Long-running poll loop. Atomic `FOR UPDATE SKIP LOCKED` claim, lease reaper, exponential backoff, configurable concurrency. |
| **Processing worker**  | `src/store/processing/worker.ts`   | Second queue worker: claims from `wa.media_processing`, routes to AI processors, stores result text. |
| **AI processors**      | `src/store/processing/processors/` | `gemini.ts` (video+image via GCS URI), `elevenlabs.ts` (audio transcription), `llamaparse.ts` (document→markdown). |
| **Prompts**            | `src/store/processing/prompts.ts`  | Default video/image prompts with env-var override support.                                           |
| **Message bus**        | `src/store/bus.ts`                 | Typed in-process EventEmitter fired by handlers after DB writes; consumed by the webhook enqueuer.   |
| **HTTP API**           | `src/api/`                         | Fastify factory + bearer-auth + route modules (`health`, `chats`, `messages`, `send`, `actions`, `webhooks`). |
| **API payloads**       | `src/api/payloads.ts`              | `buildMessagePayload()` — single rich JSON shape shared by webhook deliveries and GET endpoints.     |
| **Webhook enqueuer**   | `src/webhooks/enqueue.ts`          | `MessageBus` listener that fans events to matching active subscriptions; inserts `wa.webhook_deliveries` rows. |
| **Webhook worker**     | `src/webhooks/worker.ts`           | Drains deliveries via FOR UPDATE SKIP LOCKED; HMAC-SHA256 signs and POSTs; exponential-backoff retries. |
| **Renderer**           | `src/render/*.ts`                  | Phone/JID → fully merged Markdown timeline.                                                          |
| **Recon tool**         | `src/recon/*.ts`                   | One-shot Baileys event dumper used during initial design.                                            |

## Boot sequence

1. `src/index.ts` → `verifyDb()` runs `SELECT current_database()`; hard-fails
   on bad `DATABASE_URL`.
2. `Bot.start()` calls `ChatStore.open()` which `INSERT … ON CONFLICT DO
   NOTHING` for the configured `WA_ACCOUNT_LABEL` and returns the
   `accountId` (UUID).
3. `Bot.start()` then calls `loadAuthState(accountId)` which:
   - One-time imports any legacy `data/auth/` folder into `wa.auth_creds`
     and `wa.auth_keys`, then archives the folder to
     `data/auth.migrated-<ts>/` (non-destructive).
   - Otherwise, reads existing creds + signal keys from Postgres.
   - Falls back to fresh `initAuthCreds()` when no row exists, which
     triggers a QR-pair flow on the next connect.
4. `Bot.start()` builds the **`MediaStorage`** (Firebase if
   `FIREBASE_STORAGE_BUCKET` is set, otherwise a `NoopStorage`) and starts
   the **`MediaWorker`**. The store registers the worker as a queue
   listener so every `messages.upsert` and `messaging-history.set` chunk
   triggers `worker.notify()`, skipping the next idle poll.
5. `Bot.connect()` creates the Baileys socket with the loaded auth state
   and calls `store.bind(sock)`. From this point on, every event Baileys
   emits produces a row (or many) in Postgres.
6. The socket either loads existing creds (silent connect) or prints a QR
   to stdout. After pair, WhatsApp triggers a *messaging-history.set*
   storm; `handleHistorySet` ingests each chunk idempotently. Inserted
   `wa.media` rows wake the worker which begins draining the queue in
   parallel with ongoing message ingestion.
7. `Bot.start()` also starts the **`ProcessingWorker`** which drains
   `wa.media_processing`. When the media worker finishes uploading a file,
   `enqueueProcessing()` inserts a processing job; the processing worker
   picks it up and routes to the appropriate AI service.
8. Real-time events take over. The bot's hello-world handler runs in
   parallel with the store's persistence handlers, media worker, and
   processing worker.

## Data flow at a glance

```
Baileys event           Store handler (src/store/handlers/)        Tables touched
─────────────────────────────────────────────────────────────────────────────────────
connection.update    →  account.updateAccountIdentity()         →  wa.accounts
contacts.upsert/     →  contacts.upsertContacts()               →  wa.contacts
  contacts.update
chats.upsert/        →  chats.upsertChats()                     →  wa.chats
  chats.update
chats.delete         →  chats.markChatCleared()                 →  wa.chats(cleared_at)
messaging-history.   →  history.handleHistorySet()              →  wa.contacts, chats,
  set                                                              messages, lid_mappings,
                                                                   sync_state
messaging-history.   →  history.handleHistoryStatus()           →  wa.sync_state
  status
messages.upsert      →  messages.upsertMessages()               →  wa.messages, wa.media
                        ├─ extracts reactionMessage             →  wa.reactions
                        └─ extracts protocolMessage REVOKE      →  wa.messages(deleted_at)
messages.update      →  messages.handleMessageUpdates()         →  wa.messages,
                                                                   wa.message_edits
messages.delete      →  messages.handleMessageDeletes()         →  wa.messages(deleted_at)
messages.reaction    →  reactions.handleReactions()             →  wa.reactions
                       (legacy path; modern WA inlines via
                        messages.upsert → reactionMessage)
message-receipt.     →  misc.recordReceipts()                   →  wa.message_receipts
  update
groups.upsert/       →  groups.upsertGroups()                   →  wa.chats,
  groups.update                                                     wa.group_participants
group-participants.  →  groups.handleGroupParticipantsUpdate()  →  wa.group_participants
  update
labels.edit          →  misc.upsertLabel()                      →  wa.labels
labels.association   →  misc.upsertLabelAssociation()           →  wa.label_associations
settings.update      →  misc.updateSetting()                    →  wa.settings
lid-mapping.update   →  lid.upsertLidMappings()                 →  wa.lid_mappings
all unmodeled        →  misc.logEvent()                         →  wa.event_log
```

See [`INGESTION.md`](INGESTION.md) for the full semantics of each handler.

## Why Postgres (Supabase)

- **Durability + relational integrity.** A WhatsApp account contains a graph
  of chats → messages → edits/reactions/media; relational FKs catch most
  consistency bugs at insert time.
- **Multi-account ready.** Composite primary keys begin with `account_id`
  so a single DB can host many bots.
- **Free tier sufficient.** A bot's data volume is small (typically <1 GB
  for years of history) and Supabase covers it.
- **Drizzle ORM + raw SQL escape hatch.** Drizzle gives us typed queries
  and migrations; `postgres-js` is exposed as `sql` for the rare ad-hoc
  query.
- **Transaction-pooler aware.** `src/db/client.ts` detects port 6543 and
  disables prepared statements (Supabase pgBouncer in transaction mode
  doesn't support PREPARE).

## Auth state (Postgres-backed)

Baileys explicitly warns against using `useMultiFileAuthState` in
production — it issues one filesystem read or write per signal key, and
real WhatsApp accounts can carry **thousands** of them (typically ~800
pre-keys plus hundreds of LID mappings, sessions, sender-keys, etc.).

`src/auth.ts` implements the same `AuthenticationState` contract
(`{ creds, keys: { get, set, clear } }`) but backed by two Postgres
tables:

- `wa.auth_creds (account_id PK, creds JSONB)` — single row per account,
  written every time Baileys emits `creds.update`.
- `wa.auth_keys (account_id, type, id PK, value JSONB)` — every Signal
  key Baileys persists. One bulk SELECT per `keys.get(type, ids[])` and
  one bulk UPSERT + one bulk DELETE per `keys.set(SignalDataSet)`,
  wrapped in a transaction.

The store is wrapped in Baileys' own `makeCacheableSignalKeyStore` so
hot keys never round-trip the DB during message decryption.

Bytes are persisted as JSONB via Baileys' `BufferJSON.replacer`, the
same format `useMultiFileAuthState` writes. This keeps wire-format
parity, so:

- A bot upgraded from the file-based impl auto-imports its existing
  `data/auth/` folder on first boot (and archives it to
  `data/auth.migrated-<ts>/`).
- `app-state-sync-key` values are re-hydrated to the proto class on read
  via `proto.Message.AppStateSyncKeyData.fromObject`.

`auth.clear()` deletes every `auth_keys` and `auth_creds` row for the
account; called on permanent `loggedOut` so the next start triggers a
fresh QR pair.

## Media pipeline (Postgres queue → Firebase Storage)

The `wa.media` table doubles as a metadata store **and** a durable work
queue. Every media-bearing message ingested by `messages.upsertMessages`
inserts a row with `download_status='pending'`; the bytes are not touched
yet. A long-running [`MediaWorker`](../src/store/media/worker.ts) drains
that queue:

```
                         atomic claim
                         (FOR UPDATE SKIP LOCKED)
       ┌──────┐         ┌──────────────┐         ┌──────────┐
       │ wa.  │ ◄───────│ MediaWorker   │────────►│ Baileys  │
       │ media│         │ pollLoop()    │ get raw │ download │
       │      │         │ + lease reaper│ message │MediaMsg()│
       └──────┘         └───────┬──────┘         └────┬─────┘
                                │                     │ buffer
                                │ on done             ▼
                                │              ┌──────────────┐
                                ▼              │  Firebase    │
                         ┌──────────────┐      │  Storage     │
                         │ UPDATE       │ ◄────│  bucket.file │
                         │ wa.media     │      │  .save()     │
                         │ SET status…  │      └──────────────┘
                         └──────────────┘
```

Why a Postgres queue instead of Cloud Tasks / Sidekiq / a separate
broker:

- **Durable** — the queue lives in the same DB as the message it
  references; no broker can drift.
- **Atomic claim** — `FOR UPDATE SKIP LOCKED` is deadlock-free and
  handles thousands of jobs/sec, far above what a WA bot needs.
- **Free retries / backoff** — the next-attempt timestamp is just a
  column. No DLQs, no extra infra.
- **Crash recovery** — leases (`lease_until`) let a reaper sweep
  abandoned in-progress rows on every poll cycle.

The storage backend is abstracted behind the
[`MediaStorage`](../src/store/media/storage.ts) interface. The default
`FirebaseStorage` uses the `firebase-admin/storage` SDK (`bucket.file().save(buffer)`)
and produces a token-bearing public URL via `getDownloadURL()`. Adding
S3/R2 later is one new class.

See [`INGESTION.md`](INGESTION.md#media-pipeline-download--upload--persist)
for the full state machine, tuning knobs, failure modes, and
operational queries.

## Why an LRU + the DB for `getMessage`

Baileys uses `getMessage(key)` to:

- Decrypt poll-vote messages (lookup the original poll question).
- Resend a message you sent that the recipient claims they never got.

It's called frequently and on the hot path. Hitting the DB every time would
add per-event latency. We keep a 2,000-entry LRU; on miss, we load
`raw_message` from `wa.messages` and revive the proto via `BufferJSON`.

## Configuration surface

The whole runtime is configured through `.env` (loaded via `dotenv`). The
config object is `src/config.ts` and is referenced everywhere as
`config.*`. Adding a new env var is one place: extend `AppConfig` and the
parsing block, then document it in `.env.example` and `docs/OPERATIONS.md`.
