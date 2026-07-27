# scandi-wa-bot

A production-grade WhatsApp bot built on [Baileys 7.x](https://baileys.wiki),
designed to run long-lived on a single host (e.g. an Ubuntu droplet on
DigitalOcean) and serve as the foundation for scheduled report delivery,
message-based commands, and downstream LLM agents.

The bot does four things today:

1. **Listens** to a WhatsApp account paired via QR (or pairing code).
2. **Persists** every chat, contact, message, edit, deletion, reaction, media
   reference, group state, and sync watermark into a PostgreSQL database
   under the `wa` schema. The store mirrors what a full WhatsApp Web client
   would keep, with idempotent upserts so history-sync re-runs are no-ops.
3. **Processes** media via AI (Gemini for image/video, ElevenLabs for audio,
   LlamaParse for documents), so every media row gets a searchable
   text/transcript/markdown projection.
4. **Exposes** an HTTP API for AI agents and cron jobs to read chat history,
   send / react / edit / delete messages, fetch media, hold typing
   indicators, and subscribe to durable HMAC-signed webhooks. See
   [`docs/API.md`](docs/API.md).
5. **Behaves like a client** on the presence layer: live inbound messages
   are marked read automatically, and consumers can keep "typing…" up while
   they compose a reply.

The bot survives reconnects, app restarts, history-sync overlap, message
edits, and deletions without losing data.

---

## Quickstart

```bash
# 1. Install
nvm use 20            # Baileys 7 requires Node ≥ 20
npm install

# 2. Configure
cp .env.example .env
$EDITOR .env          # set DATABASE_URL (see docs/OPERATIONS.md)

# 3. Apply schema migrations (one-time)
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# 4. Run
npm run dev           # auto-restart on file changes; QR code on first run

# 5. Render a conversation
npm run render -- +359884430293
# → out/359884430293_<timestamp>.md
```

## What's in the box

| Path                          | Purpose                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `src/index.ts`                | Entry point; DB verify, bot start, graceful shutdown.           |
| `src/bot.ts`                  | Socket lifecycle: QR pairing, reconnect, group-metadata cache.  |
| `src/auth.ts`                 | Postgres-backed Baileys auth state (replaces `useMultiFileAuthState`). |
| `src/handlers/messages.ts`    | The hello-world responder (the only "feature" so far).          |
| `src/store/`                  | The persistent message store (see `docs/INGESTION.md`).         |
| `src/presence/`               | Read receipts + typing-indicator sessions (see `docs/API.md` §6.7). |
| `src/api/`                    | Fastify HTTP API and webhook management routes.                 |
| `src/db/`                     | Drizzle ORM schema, postgres-js client, IPv4 DNS guard.         |
| `src/render/`                 | Conversation → Markdown renderer (see `docs/RENDERER.md`).      |
| `src/recon/`                  | One-shot tool that dumps raw Baileys events to JSONL for study. |
| `db/migrations/`              | Idempotent SQL migrations.                                      |
| `data/auth/`                  | _Legacy_ file-backed creds (auto-imported into Postgres on first boot, then archived). |
| `out/`                        | Rendered conversation Markdown files. Gitignored.               |

## NPM scripts

| Command            | What it does                                                   |
| ------------------ | -------------------------------------------------------------- |
| `npm run dev`      | tsx watch — restart on `src/**` changes.                       |
| `npm run build`    | TypeScript → `dist/`.                                          |
| `npm start`        | Run the compiled `dist/index.js`.                              |
| `npm run typecheck`| `tsc --noEmit`.                                                |
| `npm run render`   | Render a conversation by phone or JID to Markdown in `out/`.   |
| `npm run recon`    | Dump raw Baileys events as JSONL for offline analysis.         |

## Deeper documentation

| Doc                              | Contents                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | High-level component layout, process model, data flow.                              |
| [`docs/SCHEMA.md`](docs/SCHEMA.md)             | Every table in `wa.*`, with columns, indexes, FKs, invariants, ER diagram.          |
| [`docs/INGESTION.md`](docs/INGESTION.md)       | Baileys event → table mapping; LID handling; edits; deletions; reactions; sync.     |
| [`docs/RENDERER.md`](docs/RENDERER.md)         | How `npm run render` works; PN/LID JID merging; Markdown format spec.               |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md)     | Setup, monitoring, troubleshooting, common ops queries.                             |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)     | Production runbook: DigitalOcean droplet, hardening, systemd, atomic deploys.       |
| [`docs/API.md`](docs/API.md)                   | Full external integration guide: WhatsApp/Baileys primer, every endpoint, webhook contract & signing, media model, integration recipes, error catalog. |

## Status, scope, what isn't built yet

**Built:**

- Baileys 7 socket lifecycle with auto-reconnect and QR pair.
- **Postgres-backed `AuthenticationState`** (replaces
  `useMultiFileAuthState`). Bulk SELECT/UPSERT/DELETE per Baileys batch
  and an in-memory cache wrapper for hot keys. Auto-imports any legacy
  `data/auth/` folder once.
- Full PostgreSQL message store (chats, contacts, messages, edits,
  reactions, media metadata, group participants, LID mappings, labels,
  settings, sync watermarks). Idempotent across history-sync overlap and
  real-time updates.
- Edit history (`wa.message_edits`) and deletion tombstones with reason
  attribution.
- **Media pipeline:** every image / video / audio / document / sticker
  / PTV / GIF gets decrypted via Baileys' `downloadMediaMessage` and
  uploaded to a Firebase Storage bucket. The `wa.media` table doubles
  as a Postgres-backed work queue with `FOR UPDATE SKIP LOCKED` claim,
  exponential backoff, and lease-based crash recovery — no Redis or
  Cloud Tasks required. Pluggable storage backend (Firebase today,
  trivially swappable for S3/R2 later).
- Conversation renderer that merges PN-form and LID-form chats and exports
  a Markdown timeline including reactions, edits, deletions, system events.

- **AI processing pipeline:** after media upload, a second Postgres-backed
  queue (`wa.media_processing`) routes files to AI services for analysis:
  - **Video/Image** → Gemini (via `gs://` URI, zero re-download)
  - **Audio** → ElevenLabs Scribe v2 (full transcript)
  - **Documents** → LlamaParse (PDF/DOCX/XLSX → clean Markdown)
  - Customizable prompts, exponential backoff, crash recovery.
  - Results stored as text in `wa.media_processing.result_text`.
- **HTTP API + webhook layer:** Fastify server on the same process as
  the socket. Bearer-auth, TypeBox-validated routes for chats/messages/
  send/react/edit/delete, durable HMAC-signed webhooks backed by a third
  Postgres queue (`wa.webhook_deliveries`) with the same `FOR UPDATE SKIP
  LOCKED` worker pattern. See [`docs/API.md`](docs/API.md).
- **Presence:** automatic read receipts for live inbound messages
  (batched, jittered, backfill excluded) and API-driven typing indicators
  that the bot refreshes ahead of WhatsApp's ~10s chatstate expiry, bounded
  by a TTL so a crashed consumer can't leave a chat typing.

**Not yet built (deliberately):**

- LLM tool wrappers around the HTTP API (a separate layer, deferred).
- Multi-tenant API keys / per-key scopes / rate limiting.
- Inbound media proxy streaming optimisations (v1 buffers in memory).
- Calls (`call.*`), inbound presence events (other people typing / online),
  SSE/WebSocket push.
- Scheduled report delivery (cron jobs that pull from internal API and
  message a chat at a fixed time).
- Telegram bridge for re-auth notifications when the WA session drops.
- Alternate auth backends (Redis / SQLite) — `src/auth.ts` already
  isolates the storage shape; an alternate implementation just needs to
  satisfy the `AuthHandle` contract.

## Important caveats

- The auth state in `wa.auth_creds` / `wa.auth_keys` **is the session
  credential** — anyone with read access can impersonate the WhatsApp
  account. Lock down the DB role (RLS is on by default; only the bot's
  privileged role bypasses it) and never expose those tables via
  PostgREST.
- `DATABASE_URL` likewise grants full DB access. Keep it out of logs.
- Baileys is unofficial; do not abuse it (no spam, no bulk messaging).
  WhatsApp bans aggressively. The presence layer is deliberately
  conservative for this reason: receipts are batched behind a randomised
  delay and never applied to history backfill, typing refreshes are
  jittered and capped, and Baileys 7 no longer sends delivery ACKs at all
  (WhatsApp was banning for it).
- Read receipts only produce blue ticks when the linked account has read
  receipts enabled in WhatsApp's privacy settings; otherwise WhatsApp
  downgrades them to `read-self`. The bot warns on connect when it sees
  this.
- The WA Web protocol version is intentionally pinned to whatever Baileys
  ships with. We do **not** call `fetchLatestBaileysVersion()` because per
  the v7 docs it can land you on an incompatible protocol version.
