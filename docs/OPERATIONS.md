# Operations

How to run the bot locally, how to deploy it, what to monitor, and what
to query when things look wrong.

## Local setup

### Prerequisites

- Node.js ≥ 20 (`nvm use 20`)
- A Postgres database (we use Supabase)
- WhatsApp on a phone you control (for QR pair)

### First-time setup

```bash
git clone <repo>
cd scandi-wa-bot

nvm use 20
npm install

cp .env.example .env
$EDITOR .env       # see "Configuration" below

# Apply schema migrations (in order)
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

npm run dev        # prints a QR; scan with WhatsApp → Linked devices
```

After `connection opened` shows in the log you're paired. The phone will
trickle history-sync events to the bot for the next several minutes;
watch `wa.sync_state.history_progress_pct` climb to 100 and then
`initial_sync_done = true`.

### Configuration (`.env`)

| Variable                  | Default            | Meaning                                                                            |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `LOG_LEVEL`               | `info`             | `trace`/`debug`/`info`/`warn`/`error`/`fatal`. Use `debug` while tuning.           |
| `DATABASE_URL`            | **required**       | Supabase **transaction pooler** URL (port `6543`). See below.                      |
| `WA_ACCOUNT_LABEL`        | `default`          | Stable identifier for this account in the DB. One DB can host many bots.           |
| `AUTH_DIR`                | `data/auth`        | **Legacy.** Only consulted on first boot to one-time import a pre-existing file-based auth dir. New installs can ignore this; the Postgres tables `wa.auth_creds` / `wa.auth_keys` are the live source of truth. |
| `BROWSER_PLATFORM`        | `Ubuntu`           | Either `Ubuntu`, `macOS`, or `Windows`. Cosmetic for the WA Linked Devices list.   |
| `BROWSER_NAME`            | `Desktop`          | **Use `Desktop` to unlock deep history sync.** Other names limit history depth.    |
| `SYNC_FULL_HISTORY`       | `true`             | Ask WhatsApp for the full history after pair.                                      |
| `MARK_ONLINE_ON_CONNECT`  | `false`            | When `false`, your phone keeps getting WA push notifications.                      |
| `ALLOWED_JIDS`            | _(empty)_          | Comma-separated allow-list for outbound messages (handy while testing).            |
| `FIREBASE_STORAGE_BUCKET` | _(empty)_          | When set, the media downloader is enabled. See "Media storage setup" below.        |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | _(empty)_    | Path to a service-account JSON. Alternative: `FIREBASE_SERVICE_ACCOUNT_JSON` (inline) or `GOOGLE_APPLICATION_CREDENTIALS` (ADC). |
| `MEDIA_DOWNLOAD_ENABLED`  | auto               | Master switch. Defaults to ON when `FIREBASE_STORAGE_BUCKET` is set.               |
| `MEDIA_TYPES`             | all 7              | Allow-list of media types to upload (`image,video,audio,document,sticker,ptv,gif`). |
| `MEDIA_MAX_BYTES`         | `104857600` (100 MiB) | Per-file size cap. Larger files are marked `skipped`.                           |
| `MEDIA_DOWNLOAD_CONCURRENCY` | `3`             | Parallel downloads.                                                                |
| `MEDIA_DOWNLOAD_BATCH_SIZE` | `10`             | Rows claimed per poll cycle.                                                       |
| `MEDIA_DOWNLOAD_POLL_MS`  | `5000`             | Idle poll interval (worker also wakes on every new media row).                     |
| `MEDIA_LEASE_SECONDS`     | `120`              | How long a row stays `in_progress` before the reaper takes it back.                |
| `MEDIA_MAX_ATTEMPTS`      | `6`                | Hard cap on transient retries before a row is marked `failed`.                     |
| `GEMINI_API_KEY`          | _(empty)_          | Enables video + image processing via Gemini. Get from AI Studio.                   |
| `ELEVENLABS_API_KEY`      | _(empty)_          | Enables audio transcription via ElevenLabs Scribe.                                 |
| `LLAMA_CLOUD_API_KEY`     | _(empty)_          | Enables document-to-markdown via LlamaParse.                                       |
| `PROCESSING_ENABLED`      | auto               | Master switch. Defaults to ON when any AI key is set.                              |
| `PROCESSING_MODEL_VIDEO`  | `gemini-2.5-flash` | Gemini model for video + image analysis.                                           |
| `PROCESSING_MODEL_AUDIO`  | `scribe_v2`        | ElevenLabs model for transcription.                                                |
| `PROCESSING_LLAMAPARSE_TIER` | `agentic`       | LlamaParse tier (`fast`/`cost_effective`/`agentic`/`agentic_plus`).                 |
| `PROCESSING_CONCURRENCY`  | `2`                | Parallel AI calls.                                                                 |
| `PROCESSING_LEASE_SECONDS`| `600`              | 10-minute lease (AI calls are slow).                                               |
| `PROCESSING_MAX_ATTEMPTS` | `4`                | Backoff: 1m → 5m → 30m → 2h, then `failed`.                                       |

### `DATABASE_URL` shape (Supabase)

Use the **transaction pooler** URI from Supabase → Project Settings →
Database → Connection string → Transaction pooler tab:

```
postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Notes:

- The user is `postgres.<project-ref>`, **not** plain `postgres`.
- URL-encode the password if it contains `@`, `#`, etc. (`@` → `%40`).
- Port **6543** is the transaction pooler. Our DB client auto-detects this
  port and disables prepared statements (Supabase's pgBouncer in
  transaction mode doesn't support PREPARE).
- Port **5432** (session pooler / direct) supports PREPARE; the client
  enables it automatically.

### Media storage setup (Firebase Storage)

The bot writes original media bytes to a Firebase Storage bucket (which
is just a Google Cloud Storage bucket with a Firebase-friendly URL
scheme). Setup once per project:

1. **Enable Storage** in the Firebase Console for your project.
   Storage requires the **Blaze (pay-as-you-go) plan** even though the
   free tier is plenty for normal bot traffic.
2. **Find the bucket name.** Console → Storage → header shows
   `gs://<bucket>`. Copy `<bucket>` (no `gs://` prefix). Modern projects
   are `<project-id>.firebasestorage.app`; older ones are
   `<project-id>.appspot.com`.
3. **Create a service account.** Console → Project Settings → Service
   accounts → "Generate new private key". Save the JSON somewhere safe
   (we suggest `secrets/firebase-service-account.json`, which is
   gitignored). Make sure the service account has the **Storage Admin**
   IAM role (the auto-generated "Firebase Admin SDK" account already
   does).
4. **Wire it into `.env`.**

   ```dotenv
   FIREBASE_STORAGE_BUCKET=my-project.firebasestorage.app
   FIREBASE_SERVICE_ACCOUNT_PATH=secrets/firebase-service-account.json
   ```

   Alternatives if you'd rather not have a JSON file on disk:

   - `FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'` —
     paste the same JSON inline (e.g. for Docker secrets / Heroku env).
   - Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` — Firebase
     Admin will pick this up via Application Default Credentials with
     no other config needed.

5. **Restart the bot.** On boot you'll see
   `media storage: firebase ready`, and the worker will start draining
   any `pending` rows already in `wa.media`.

If `FIREBASE_STORAGE_BUCKET` is unset the bot still runs end-to-end:
metadata is captured into `wa.media` as usual, the worker idles, and
no upload attempts are made. Adding credentials later and restarting
backfills the queue automatically.

### IPv6 / `ENETUNREACH` workaround

Supabase's direct DB host advertises IPv6 connectivity on the free tier;
some consumer ISPs and Docker default networks can't actually route to
it, leading to `ENETUNREACH`. `src/db/client.ts` pre-resolves the URL
hostname to an IPv4 address at boot, sidesteppling Node's happy-eyeballs
entirely. No action needed; this is automatic.

## Running modes

| Mode    | Command          | Behaviour                                            |
| ------- | ---------------- | ---------------------------------------------------- |
| Dev     | `npm run dev`    | `tsx watch src/index.ts` — restart on file changes.  |
| Build   | `npm run build`  | TypeScript → `dist/`.                                |
| Start   | `npm start`      | Run compiled `dist/index.js`.                        |
| Recon   | `npm run recon`  | Dump raw Baileys events to `data/recon/<date>/*.jsonl`. |
| Render  | `npm run render -- <phone-or-jid> [out.md]` | Markdown export. |

## Deployment (Ubuntu / DigitalOcean)

A simple, robust setup:

- Run under a process supervisor (`systemd`, `pm2`, or similar). The bot
  exits with code `1` on permanent `loggedOut` so the supervisor can
  restart it; on transient drops it reconnects internally.
- The session lives in Postgres (`wa.auth_creds` + `wa.auth_keys`) — back
  up the DB, not the host. Losing those rows forces a fresh QR pair.
  The `data/` folder no longer carries any state for new installs.
- Make sure outbound TCP 443 to `web.whatsapp.com` is open.
- Pin `node` to ≥ 20 (Baileys 7 requirement).

Example systemd unit:

```ini
[Unit]
Description=scandi-wa-bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=scandi
WorkingDirectory=/opt/scandi-wa-bot
EnvironmentFile=/opt/scandi-wa-bot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

# Hard-fail safety
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
npm run build
sudo systemctl daemon-reload
sudo systemctl enable --now scandi-wa-bot
journalctl -u scandi-wa-bot -f
```

## What to monitor

- **`wa.accounts.status`** — should be `active`. `logged_out` means the
  user removed the linked device or WA forced a re-pair.
- **`wa.sync_state.last_event_at`** — should advance regularly. Stale =
  socket may be dead.
- **`wa.sync_state.initial_sync_done`** — flips to `true` after the first
  pair completes.
- **Process logs** — pino emits NDJSON in production, colorized in dev.
  `journalctl -u scandi-wa-bot -f` is your friend.

## Common ops queries

The MCP / `psql` examples below assume you're connected to the project DB.

### Health snapshot

```sql
SELECT
  a.label,
  a.status,
  a.self_pn_jid,
  a.self_lid_jid,
  s.history_progress_pct,
  s.initial_sync_done,
  s.last_event_at
FROM wa.accounts a
LEFT JOIN wa.sync_state s ON s.account_id = a.id;
```

### Counts by table

```sql
SELECT 'chats',     count(*) FROM wa.chats     UNION ALL
SELECT 'contacts',  count(*) FROM wa.contacts  UNION ALL
SELECT 'messages',  count(*) FROM wa.messages  UNION ALL
SELECT 'edits',     count(*) FROM wa.message_edits UNION ALL
SELECT 'reactions', count(*) FROM wa.reactions UNION ALL
SELECT 'media',     count(*) FROM wa.media     UNION ALL
SELECT 'tombstones', count(*) FROM wa.messages WHERE tombstone
ORDER BY 1;
```

### Recent activity

```sql
SELECT m.chat_jid, c.subject, m.id, m.from_me, m.message_type, m.text, m.ts
FROM wa.messages m
LEFT JOIN wa.chats c ON c.account_id = m.account_id AND c.jid = m.chat_jid
ORDER BY m.ts DESC
LIMIT 20;
```

### Find a specific contact

```sql
SELECT jid, pn, lid, name, push_name
FROM wa.contacts
WHERE pn ILIKE '%359884430293%' OR jid ILIKE '%359884430293%';
```

### Media queue health

```sql
-- queue depth at a glance
SELECT download_status, count(*), min(inserted_at) AS oldest
FROM wa.media GROUP BY 1 ORDER BY 1;

-- what's about to be tried, and what's deferred for backoff
SELECT id, chat_jid, message_id, media_type, download_attempts,
       download_error, next_attempt_at
FROM wa.media
WHERE download_status = 'pending'
ORDER BY next_attempt_at LIMIT 20;

-- in-flight rows (the worker is processing these now)
SELECT id, worker_id, lease_until, download_attempts
FROM wa.media WHERE download_status = 'in_progress';

-- biggest uploads in the last day
SELECT media_type, mime_type, size_bytes, gcs_object, completed_at
FROM wa.media
WHERE download_status='done' AND completed_at > NOW() - interval '1 day'
ORDER BY size_bytes DESC LIMIT 20;
```

### Force-retry stuck or failed media

```sql
-- retry every row that gave up (clears the attempt counter so backoff
-- starts fresh)
UPDATE wa.media
SET download_status = 'pending',
    download_attempts = 0,
    next_attempt_at = NOW(),
    download_error = NULL,
    lease_until = NULL,
    worker_id = NULL
WHERE download_status = 'failed';

-- retry a single row
UPDATE wa.media
SET download_status = 'pending', next_attempt_at = NOW(),
    download_error = NULL, lease_until = NULL, worker_id = NULL
WHERE id = 12345;
```

The worker wakes up every `MEDIA_DOWNLOAD_POLL_MS` (default 5s) and will
pick the rows up on its next poll. Setting up `LISTEN media_pending`
notifications instead is a future optimization but not necessary at our
scale.

### Trigram fuzzy text search

```sql
SELECT chat_jid, ts, text
FROM wa.messages
WHERE text % 'meeting tomorrow'        -- pg_trgm similarity
ORDER BY similarity(text, 'meeting tomorrow') DESC
LIMIT 20;
```

## Troubleshooting

### Bot prints QR every restart
Auth state isn't persisting. Check:
- `wa.auth_creds` has a row for your account: `SELECT account_id,
  jsonb_object_keys(creds) FROM wa.auth_creds;` (should list ~20 keys
  including `noiseKey`, `signedIdentityKey`, `registrationId`).
- `wa.auth_keys` has rows: `SELECT type, count(*) FROM wa.auth_keys
  GROUP BY type;` (you should see ~800 pre-keys after a successful pair).
- The bot has write permission on the DB (RLS, role privileges).
- The `creds.update` event is firing — set `LOG_LEVEL=debug` and look
  for `creds saved` lines after pair.

### `ENETUNREACH` on startup
You're on a network that can't reach the Supabase DB host over IPv6 and
the IPv4 pre-resolution failed (DNS issue). Check:
```bash
getent hosts aws-0-<region>.pooler.supabase.com
```
If only IPv6 returns, your DNS resolver is misconfigured. Add a
public-IPv4-only DNS resolver (1.1.1.1) or set `dns: 'ipv4first'` at the
OS level.

### `loggedOut` immediately after pair
Common causes:
- The phone hosting WhatsApp has been offline for too long. WA expires
  linked sessions.
- `BROWSER_NAME` is set to something WhatsApp considers spammy. Stick to
  `Desktop`.

### History sync stalls at < 100%
This is normal — WA sends the full multi-year history in chunks over
several minutes. Watch `wa.sync_state.history_progress_pct` and
`history_chunk_order` to confirm progress. If it really hangs, check
that your phone has a stable internet connection.

### Reactions / deletions not appearing in render
The render filters reactionMessage and REVOKE protocol envelopes. The
*effect* should appear on the target. If it doesn't:
- Verify the reaction is in `wa.reactions` (`SELECT … WHERE chat_jid IN
  (jids)`).
- Verify the deletion set `wa.messages.deleted_at`.
- For older data captured before the inline-reaction / outer-chat-revoke
  fix, run the backfill SQL below.

## One-shot backfills

These are idempotent. Run as a one-time fix when upgrading from a build
without inline reaction routing or outer-chat REVOKE handling.

### Backfill inline reactions
```sql
WITH reaction_msgs AS (
  SELECT
    m.account_id,
    m.chat_jid,
    m.raw_message->'reactionMessage'->'key'->>'id' AS target_id,
    NULLIF(m.raw_message->'reactionMessage'->>'text', '') AS emoji,
    COALESCE(
      to_timestamp(((m.raw_message->'reactionMessage'->>'senderTimestampMs')::bigint) / 1000.0),
      m.ts
    ) AS ts,
    m.from_me,
    NULLIF(m.participant, '') AS participant,
    a.self_lid_jid,
    a.self_pn_jid
  FROM wa.messages m
  JOIN wa.accounts a ON a.id = m.account_id
  WHERE m.raw_message->'reactionMessage'->'key'->>'id' IS NOT NULL
)
INSERT INTO wa.reactions (account_id, chat_jid, message_id, actor_jid, emoji, ts)
SELECT
  rm.account_id, rm.chat_jid, rm.target_id,
  CASE
    WHEN rm.participant IS NOT NULL THEN rm.participant
    WHEN rm.from_me AND rm.chat_jid LIKE '%@lid' THEN COALESCE(rm.self_lid_jid, rm.self_pn_jid)
    WHEN rm.from_me THEN COALESCE(rm.self_pn_jid, rm.self_lid_jid)
    ELSE rm.chat_jid
  END,
  rm.emoji, rm.ts
FROM reaction_msgs rm
WHERE 1=1
ON CONFLICT (account_id, chat_jid, message_id, actor_jid) DO UPDATE
SET emoji = CASE WHEN EXCLUDED.ts >= wa.reactions.ts THEN EXCLUDED.emoji ELSE wa.reactions.emoji END,
    ts    = GREATEST(wa.reactions.ts, EXCLUDED.ts);
```

### Re-tombstone REVOKEs in the correct outer chat
```sql
WITH revokes AS (
  SELECT
    m.account_id,
    m.chat_jid AS outer_chat,
    m.raw_message->'protocolMessage'->'key'->>'id' AS target_id,
    m.from_me AS revoker_is_self,
    NULLIF(m.participant, '') AS revoker_participant,
    m.ts AS revoke_ts
  FROM wa.messages m
  WHERE m.raw_message->'protocolMessage'->>'type' = 'REVOKE'
)
-- Tombstone existing originals
UPDATE wa.messages m
SET deleted_at = COALESCE(m.deleted_at, NOW()),
    deletion_reason = COALESCE(m.deletion_reason, 'sender_revoke'),
    deleted_by_jid = COALESCE(m.deleted_by_jid, r.revoker_participant,
                              CASE WHEN r.revoker_is_self THEN NULL ELSE r.outer_chat END),
    tombstone = TRUE
FROM revokes r
WHERE m.account_id = r.account_id
  AND m.chat_jid = r.outer_chat
  AND m.id = r.target_id;

-- Insert orphan tombstones for revokes whose targets we never synced
WITH revokes AS (
  SELECT
    m.account_id,
    m.chat_jid AS outer_chat,
    m.raw_message->'protocolMessage'->'key'->>'id' AS target_id,
    m.from_me AS revoker_is_self,
    NULLIF(m.participant, '') AS revoker_participant,
    m.ts AS revoke_ts
  FROM wa.messages m
  WHERE m.raw_message->'protocolMessage'->>'type' = 'REVOKE'
)
INSERT INTO wa.messages (
  account_id, chat_jid, id, from_me, ts,
  deleted_at, deleted_by_jid, deletion_reason, tombstone, raw_envelope
)
SELECT r.account_id, r.outer_chat, r.target_id, FALSE, r.revoke_ts,
       r.revoke_ts,
       COALESCE(r.revoker_participant, CASE WHEN r.revoker_is_self THEN NULL ELSE r.outer_chat END),
       'sender_revoke', TRUE,
       jsonb_build_object('_tombstone', true, 'source', 'backfill_revoke')
FROM revokes r
LEFT JOIN wa.messages existing
  ON existing.account_id = r.account_id
 AND existing.chat_jid = r.outer_chat
 AND existing.id = r.target_id
WHERE existing.id IS NULL
ON CONFLICT (account_id, chat_jid, id) DO NOTHING;
```

### Drop misplaced tombstones in self-LID chat
```sql
DELETE FROM wa.messages
WHERE raw_message IS NULL
  AND tombstone = TRUE
  AND raw_envelope ? '_tombstone'
  AND chat_jid IN (
    -- the bot's own bare LID (without device suffix)
    SELECT regexp_replace(self_lid_jid, ':\d+@', '@') FROM wa.accounts
  );

DELETE FROM wa.chats c
WHERE jid IN (
  SELECT regexp_replace(self_lid_jid, ':\d+@', '@') FROM wa.accounts
)
AND NOT EXISTS (SELECT 1 FROM wa.messages m WHERE m.chat_jid = c.jid);
```

## Re-syncing from scratch

If you ever need to wipe a single account's data without affecting other
bots sharing the DB:

```sql
DELETE FROM wa.accounts WHERE label = 'default';
-- ON DELETE CASCADE removes everything in wa.* for that account,
-- including auth_creds and auth_keys.
```

Restart the bot — it'll initialize fresh creds and print a QR.

### Just clearing auth (keep messages, force re-pair)

```sql
DELETE FROM wa.auth_keys  WHERE account_id = (SELECT id FROM wa.accounts WHERE label = 'default');
DELETE FROM wa.auth_creds WHERE account_id = (SELECT id FROM wa.accounts WHERE label = 'default');
```

## Schema migrations

Migrations live in `db/migrations/` and are applied in numeric order.
Apply with `psql -f` or via the Supabase MCP `apply_migration` tool.
Future migrations should:

- Be **forward-only** and idempotent (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).
- Get a numeric prefix that sorts naturally (`0002_…`, `0003_…`).
- Be applied before deploying the new code that depends on them.

A `drizzle-kit` workflow is wired up (`drizzle.config.*` not yet
committed) for generating migrations from `src/db/schema.ts` changes.
For now we hand-craft SQL.
