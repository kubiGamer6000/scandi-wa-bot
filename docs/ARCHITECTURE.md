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
4. `Bot.connect()` creates the Baileys socket with the loaded auth state
   and calls `store.bind(sock)`. From this point on, every event Baileys
   emits produces a row (or many) in Postgres.
5. The socket either loads existing creds (silent connect) or prints a QR
   to stdout. After pair, WhatsApp triggers a *messaging-history.set*
   storm; `handleHistorySet` ingests each chunk idempotently.
6. Real-time events take over. The bot's hello-world handler runs in
   parallel with the store's persistence handlers.

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
