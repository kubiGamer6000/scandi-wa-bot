# Deployment — DigitalOcean droplet

End-to-end guide for running `scandi-wa-bot` on a fresh Ubuntu droplet,
production-ready: hardened host, dedicated app user, systemd-supervised,
journald logs, zero-touch reconnects, atomic deploys, **HTTP API + webhook
worker** under the same systemd unit, optional public HTTPS via reverse
proxy.

The bot itself is **stateless on disk** — every byte that matters
(Baileys session, messages, media, processing results, webhook
subscriptions / deliveries) lives in Supabase Postgres + Firebase
Storage. The droplet is just a runtime; if it dies, you can rebuild
from this guide and `git clone` and you're back in minutes.

What runs in a single Node process:

- Baileys WhatsApp socket
- `MediaWorker` + `ProcessingWorker` (Postgres-backed job queues)
- Fastify HTTP API on `127.0.0.1:8787` (off by default — set `API_ENABLED=true`)
- `WebhookWorker` for durable outbound webhook deliveries

systemd supervises the whole thing as one unit.

---

## 1. Droplet sizing

| Workload                                    | Recommended size                                | Monthly  |
| ------------------------------------------- | ----------------------------------------------- | -------- |
| Single account, light traffic               | **Basic Premium AMD, 1 vCPU / 2 GB / 50 GB**    | $14      |
| Single account + AI processing (videos)     | **Basic Premium AMD, 2 vCPU / 4 GB / 80 GB**    | $28      |
| Multi-account or heavy media (>10k msg/day) | **Basic 2 vCPU / 4 GB** + persistent volume     | $28+     |

Notes:
- **2 GB RAM is the floor.** Baileys' Signal session decryption + Drizzle
  + the firebase-admin SDK comfortably fit in <600 MB at idle, but
  history sync temporarily pushes RAM use up while messages stream in.
- **Disk** is mostly for Node modules (~500 MB), system, logs, and the
  legacy `data/` folder before the auth import (~50 MB). A 50 GB SSD is
  overkill but cheap.
- **Region** — pick one near your users' WhatsApp servers (Frankfurt or
  Amsterdam for EU, NYC for US East). Latency to WhatsApp matters more
  than latency to Supabase.

**Image:** Ubuntu 24.04 LTS x64.

**Authentication:** SSH keys only. Paste your public key when creating
the droplet. Never enable password SSH.

**Firewall:** add the droplet to a DigitalOcean **Cloud Firewall**
(Networking → Firewalls). Default rules:

| Direction | Protocol | Port      | Source / Destination     | Used for                              |
| --------- | -------- | --------- | ------------------------ | ------------------------------------- |
| Inbound   | TCP      | 22        | Your IP only (or 0/0)    | SSH                                   |
| Inbound   | TCP      | 80, 443   | All (only if exposing the API publicly via reverse proxy — see [§9](#9-optional-expose-the-api-publicly-via-https)) | HTTPS API |
| Outbound  | TCP      | 80        | All (`0.0.0.0/0, ::/0`)  | Let's Encrypt HTTP-01 challenges      |
| Outbound  | TCP      | 443       | All                      | WhatsApp, Supabase, Firebase, AI APIs, **webhook deliveries** to your consumers |
| Outbound  | UDP      | 53        | All                      | DNS                                   |
| Outbound  | UDP      | 123       | All                      | NTP                                   |

Outbound 443 is needed for: WhatsApp web, Supabase, Firebase Storage,
Gemini API, ElevenLabs, LlamaCloud, **and outbound webhook POSTs to your
own consumers** (AI agents, n8n, etc.).

**Three exposure modes for the HTTP API**, pick one:

1. **Disabled** (default). `API_ENABLED=false`. No HTTP server starts.
   The bot only does WhatsApp + Supabase. Use this if you only want
   cron / scheduled-send capability and don't need webhooks (you can
   still send via `psql` or write a tiny one-off script that imports
   the bot's code).
2. **Localhost-only**. `API_ENABLED=true`, default `API_HOST=127.0.0.1`.
   No inbound firewall change needed. Only processes on the same droplet
   (cron, an AI agent you also deploy here) can hit the API. Webhooks
   still work — they POST outbound to wherever you configure.
3. **Public HTTPS**. Reverse proxy (Caddy / Nginx) terminates TLS on
   port 443 and forwards to `127.0.0.1:8787`. Open inbound 80+443 in
   the firewall. See [§9](#9-optional-expose-the-api-publicly-via-https).

Mode 2 is recommended unless an AI agent runs on a different host.

---

## 2. First-boot host hardening

SSH in as `root`, then:

```bash
# Pull all updates (Ubuntu's first-login banner usually nags about these).
apt update && apt -y full-upgrade && apt -y autoremove

# Set timezone (so log timestamps make sense to you).
timedatectl set-timezone Europe/Sofia    # change to yours

# Add a swap file. Optional but cheap insurance against OOM during
# history sync / Gemini concurrent video uploads.
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Auto-install security patches (kernel, libraries) every night.
apt -y install unattended-upgrades
dpkg-reconfigure --priority=low unattended-upgrades   # accept defaults

# Fail2ban — auto-ban brute-force SSH attempts.
apt -y install fail2ban
systemctl enable --now fail2ban

# Host firewall (in addition to DO Cloud Firewall — defense in depth).
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable
```

Then create a non-root user the bot will run as:

```bash
useradd -m -s /bin/bash -G sudo scandi

# IMPORTANT: set a password so `sudo` works. `useradd` does NOT prompt for
# one, and without it the account is locked for password auth — meaning
# every `sudo` call will fail with "incorrect password" even though you can
# still SSH in via your key. Recovering from this requires the VPS provider's
# web console, so don't skip this line.
passwd scandi

mkdir -p /home/scandi/.ssh
cp /root/.ssh/authorized_keys /home/scandi/.ssh/authorized_keys
chown -R scandi:scandi /home/scandi/.ssh
chmod 700 /home/scandi/.ssh
chmod 600 /home/scandi/.ssh/authorized_keys

# Sanity check BEFORE locking root: open a second terminal, run
#   ssh scandi@<droplet-ip>
# and confirm `sudo -v` accepts the password you just set. Only then proceed.

# Lock root SSH and disable password auth.
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

Log out, then back in as `scandi` from now on:

```bash
ssh scandi@<droplet-ip>
```

---

## 3. Runtime prerequisites

```bash
# Node.js 20 (via NodeSource — slimmer & easier to update than nvm for
# a single-version production host).
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs git

node --version    # v20.x
npm  --version
git  --version

# Optional: pin npm globally to a known good version.
sudo npm i -g npm@latest
```

We deliberately don't use `nvm` on the server — systemd unit files
need a deterministic `ExecStart` path, and NodeSource installs to
`/usr/bin/node` which is stable across `apt upgrade`s.

---

## 4. App layout

```bash
sudo mkdir -p /opt/scandi-wa-bot /var/log/scandi-wa-bot
sudo chown -R scandi:scandi /opt/scandi-wa-bot /var/log/scandi-wa-bot

# Clone (over HTTPS or SSH — your choice).
cd /opt
sudo -u scandi git clone https://github.com/<you>/scandi-wa-bot.git
cd scandi-wa-bot

# Install ALL deps (we need devDeps for `tsc` to build).
sudo -u scandi npm ci

# Build TypeScript → dist/.
sudo -u scandi npm run build

# Optional: drop devDeps after build to shave 200 MB.
# Don't do this if you plan to run `npm run render` ad-hoc on the box.
# sudo -u scandi npm prune --omit=dev
```

---

## 5. Secrets — `.env` and Firebase service account

```bash
sudo -u scandi mkdir -p /opt/scandi-wa-bot/secrets
cd /opt/scandi-wa-bot

# .env — copy your tested local one or paste fresh.
sudo -u scandi nano .env

# Firebase service account JSON.
sudo -u scandi nano secrets/firebase-service-account.json

# Lock down secrets so nothing else on the box can read them.
sudo chmod 600 .env secrets/firebase-service-account.json
sudo chown scandi:scandi .env secrets/firebase-service-account.json
```

Required env vars (see [`.env.example`](../.env.example) for the full
list with comments):

**Core (always needed):**

| Var                              | Required? | Notes                                                                            |
| -------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | yes       | Supabase **transaction pooler** URI (port 6543).                                 |
| `WA_ACCOUNT_LABEL`               | recommended | Stable identifier; pick something like `scandi-prod`.                          |
| `BROWSER_NAME=Desktop`           | yes       | Required for deep history sync.                                                  |
| `LOG_LEVEL=info`                 | yes       | `debug` is too chatty for production.                                            |

**Media + AI processing:**

| Var                              | Required? | Notes                                                                            |
| -------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `FIREBASE_STORAGE_BUCKET`        | for media | Without it, media stays `pending`.                                               |
| `FIREBASE_SERVICE_ACCOUNT_PATH`  | for media | `secrets/firebase-service-account.json`                                          |
| `GEMINI_API_KEY`                 | image+video AI | leave blank to skip those processors                                        |
| `ELEVENLABS_API_KEY`             | audio AI       | same                                                                        |
| `LLAMA_CLOUD_API_KEY`            | document AI    | same                                                                        |

**HTTP API + webhooks (skip if you only want cron-mode sending without
any external integrations):**

| Var                       | Required when `API_ENABLED=true` | Notes                                                                                       |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `API_ENABLED=true`        | —                                | Master switch. Off by default.                                                              |
| `API_AUTH_TOKEN`          | **yes**                          | Bearer token. **Bot refuses to start without it** when API is enabled. Generate: `openssl rand -hex 32`. |
| `API_HOST=127.0.0.1`      | optional                         | Keep `127.0.0.1` and front with a reverse proxy. Set `0.0.0.0` only if firewall is your only protection. |
| `API_PORT=8787`           | optional                         |                                                                                             |
| `API_MAX_BODY_MB=25`      | optional                         | Cap on inbound multipart uploads.                                                           |
| `WEBHOOK_CONCURRENCY=4`   | optional                         | Outbound POSTs in flight at once.                                                           |
| `WEBHOOK_TIMEOUT_MS=10000`| optional                         | Per-request HTTP timeout to your consumer.                                                  |
| `WEBHOOK_MAX_ATTEMPTS=6`  | optional                         | Total tries before `abandoned`. Default schedule: 30s → 2m → 10m → 1h → 6h → 24h.           |

See `docs/API.md` for the full integration guide for consumers.

**Verify the env loads cleanly:**

```bash
sudo -u scandi env -i HOME=/home/scandi PATH=/usr/bin /usr/bin/node \
  -e 'require("dotenv").config(); console.log(Object.keys(process.env).filter(k => /^(FIREBASE|GEMINI|DATABASE|API|WEBHOOK)/.test(k)))'
```

Should print the keys you set without errors.

---

## 6. Apply database migrations (one-time, idempotent)

Every schema migration lives in `db/migrations/`, numbered. They're
**idempotent** (re-running is safe). Apply them once per fresh database:

```bash
# Install psql if you don't have it yet
sudo apt -y install postgresql-client

# From /opt/scandi-wa-bot:
for f in db/migrations/*.sql; do
  echo "Applying $f"
  psql "$DATABASE_URL" -f "$f"
done
```

Current migrations:

| File                                | What it adds                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `0001_init_wa_schema.sql`           | Core `wa.*` schema: accounts, chats, messages, contacts, groups, reactions, sync state.        |
| `0002_auth_state.sql`               | Baileys auth-state tables (`wa.auth_creds`, `wa.auth_keys`).                                   |
| `0003_media_queue.sql`              | `wa.media` table + media download job queue.                                                   |
| `0004_media_processing.sql`         | `wa.media_processing` queue for AI processors (Gemini / ElevenLabs / LlamaParse).              |
| `0005_api_layer.sql`                | `seq` bigserial on `wa.messages`, plus `wa.webhook_subscriptions` and `wa.webhook_deliveries`. |

If you're upgrading an older deployment that's missing `0005`, run only
that one — the others have already been applied. Re-running them is
harmless because every CREATE / ALTER uses `IF NOT EXISTS`.

You can also paste each `.sql` file's contents into the Supabase SQL
Editor if you prefer not to install `psql` on the droplet.

---

## 7. systemd unit (the supervisor)

Create `/etc/systemd/system/scandi-wa-bot.service`:

```ini
[Unit]
Description=scandi-wa-bot — Baileys WhatsApp store + AI processing
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=scandi
Group=scandi
WorkingDirectory=/opt/scandi-wa-bot
EnvironmentFile=/opt/scandi-wa-bot/.env

# Use absolute path so PATH changes never break us.
ExecStart=/usr/bin/node dist/index.js

# Auto-restart on any exit. The bot exits with code 1 on permanent
# `loggedOut` so we WANT a restart loop in that case (it'll print a
# fresh QR until you pair). On transient drops the bot reconnects
# internally and never exits, so RestartSec is mostly defensive.
Restart=always
RestartSec=5

# Don't restart-storm if something's catastrophically broken.
StartLimitIntervalSec=300
StartLimitBurst=10

# Run unprivileged + sandboxed.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/scandi-wa-bot /var/log/scandi-wa-bot
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true

# Resource limits — prevents one runaway from killing the host.
MemoryMax=2G
TasksMax=512

# Logs go to journald.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=scandi-wa-bot

[Install]
WantedBy=multi-user.target
```

Activate it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable scandi-wa-bot
sudo systemctl start scandi-wa-bot
sudo systemctl status scandi-wa-bot
```

Once running, the process supervises **all** of:

- the WhatsApp socket (auto-reconnects on drop),
- the media-download worker,
- the AI-processing worker,
- the Fastify HTTP API on `127.0.0.1:8787` (if `API_ENABLED=true`),
- the outbound webhook-delivery worker.

A `SIGTERM` (sent by `systemctl restart` / `stop`) triggers a graceful
shutdown that drains in-flight HTTP requests, closes the WhatsApp
socket, then stops the workers — in that order — so you won't lose
queued webhook deliveries on deploy.

---

## 8. First-boot QR pairing (one-time)

The bot prints a QR on startup if it has no auth state in Postgres. But
when run under systemd you can't see the QR in the journal output (it's
ANSI escapes that get mangled). Two options:

### Option A — pair locally first, then deploy (recommended)

1. Run the bot once on your laptop with the same `DATABASE_URL`. Scan
   QR. Wait for `connection opened`.
2. Stop the laptop bot. The session is now in `wa.auth_creds` /
   `wa.auth_keys` in Supabase.
3. Start the droplet's systemd service. It connects silently using the
   shared session. Same WhatsApp account, both can run, only one needs
   to stay live.

### Option B — run interactively on the droplet first

```bash
sudo systemctl stop scandi-wa-bot
cd /opt/scandi-wa-bot
sudo -u scandi env $(sudo cat .env | grep -v '^#' | xargs) node dist/index.js
# Scan QR with phone (WhatsApp → Linked devices → Link a device).
# Wait for "connection opened".
# Ctrl+C.
sudo systemctl start scandi-wa-bot
```

Either way, after pairing the session lives in Postgres permanently.
The droplet is replaceable; the session is not lost when you rebuild.

---

## 9. (Optional) Expose the API publicly via HTTPS

**Skip this section** if your AI agent / consumer runs on the same
droplet — `127.0.0.1:8787` is reachable from local processes already.

Otherwise, run a reverse proxy on the droplet. **Caddy** is the simplest
choice: it requests + renews Let's Encrypt certs automatically. Nginx
also works if you already know it.

### 9.1 Prerequisites

- A DNS record (`api.example.com`) pointing at the droplet's IP.
- Inbound `80` and `443` open in the DO Cloud Firewall.

### 9.2 Caddy (recommended — auto-TLS, one config file)

```bash
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt -y install caddy
```

Edit `/etc/caddy/Caddyfile`:

```caddyfile
api.example.com {
    # Auto-fetched + renewed Let's Encrypt cert.
    encode gzip zstd

    # Reverse to the bot. The bot expects HTTP on 8787 inside the box.
    reverse_proxy 127.0.0.1:8787 {
        # Pass the original client IP through (useful for logs).
        header_up X-Forwarded-For {remote_host}

        # Webhooks the bot RECEIVES are none (we send outbound). API
        # requests are usually quick. Bump if you ever proxy big media
        # uploads.
        transport http {
            response_header_timeout 30s
        }
    }

    # Optional: drop unauth probes before they hit the bot.
    # The /v1/health endpoint is unauthenticated by design — leave it open.
}
```

```bash
sudo systemctl reload caddy
sudo systemctl enable caddy
```

Verify:

```bash
curl https://api.example.com/v1/health
# {"status":"ok","sock_connected":true,...}

curl -H "Authorization: Bearer $API_AUTH_TOKEN" https://api.example.com/v1/me
# {"account_id":"...","pn_jid":"...","lid_jid":"...",...}
```

### 9.3 Nginx (alternative)

```bash
sudo apt -y install nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/scandi-wa-bot`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.example.com;

    location / {
        proxy_pass         http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;

        client_max_body_size 30M;   # leave room above API_MAX_BODY_MB
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/scandi-wa-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Get + auto-renew TLS cert
sudo certbot --nginx -d api.example.com --redirect --non-interactive --agree-tos -m you@example.com
```

certbot installs a cron job that renews 30 days before expiry.

### 9.4 Defense in depth at the proxy layer

The Fastify API does timing-safe bearer-token auth on every request,
but if your reverse proxy is exposed publicly you may also want:

- **IP allowlisting** at the reverse proxy if your consumer's egress IPs
  are known and stable (`@allowed { remote_ip 1.2.3.0/24 }` in Caddy).
- **Connection rate limiting** at the proxy (Caddy's `rate_limit`
  plugin, or `limit_req` in Nginx) — the bot itself doesn't rate-limit
  yet.
- **Fail2ban** rule that bans IPs returning >50 `403`s in a minute
  (i.e. token brute-forcing).

For a single trusted internal consumer the bearer token alone is
usually enough.

### 9.5 Webhook endpoints on your side

**Heads up about your consumer.** The bot delivers webhooks **outbound**
(it makes `POST` requests to wherever you configured via
`POST /v1/webhooks`). Your consumer is the one that needs to:

- Be reachable from the droplet over HTTPS (this is the easy
  direction — outbound 443 is already open).
- Return HTTP 2xx within `WEBHOOK_TIMEOUT_MS` (default 10s). Anything
  slower will be marked failed and retried.
- Use the **raw** request body to verify the HMAC signature (see
  `docs/API.md` §5.5).
- Dedupe by `X-Webhook-Id` (deliveries are at-least-once).

The bot doesn't need any inbound webhook port — your webhooks travel
**from** the bot **to** your consumer.

---

## 10. Logs

### Live tail

```bash
sudo journalctl -u scandi-wa-bot -f
```

Pretty-print pino NDJSON on the fly:

```bash
sudo journalctl -u scandi-wa-bot -f -o cat | npx pino-pretty
```

### Retention

journald keeps logs in memory + `/var/log/journal/` by default. Cap it:

```bash
# /etc/systemd/journald.conf
sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sudo sed -i 's/^#MaxRetentionSec=.*/MaxRetentionSec=30day/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

That keeps ~30 days of logs in <500 MB. Plenty for forensics.

### Filter examples

```bash
# Just errors and warnings, last hour.
sudo journalctl -u scandi-wa-bot -p warning --since "1 hour ago"

# Search for a chat / message id.
sudo journalctl -u scandi-wa-bot --since today | grep ACE8C2DE

# Crash debugging (everything after the last restart).
sudo journalctl -u scandi-wa-bot -b
```

---

## 11. Deploying updates

The atomic flow: pull → build → restart. systemd handles the
graceful-shutdown side (`SIGTERM` triggers our shutdown handler which
flushes the DB pool and stops both workers).

Save this as `/opt/scandi-wa-bot/scripts/deploy.sh` (create the dir if
needed, then `chmod +x`):

```bash
#!/usr/bin/env bash
# Atomic deploy: pull, install only-if-changed, build, restart.
set -euo pipefail

cd /opt/scandi-wa-bot

echo "==> git pull"
git fetch --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u})
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date."
  exit 0
fi
git pull --ff-only

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

echo "==> restart"
sudo systemctl restart scandi-wa-bot

echo "==> tail -- ctrl-c when satisfied"
sudo journalctl -u scandi-wa-bot -f
```

Run as the `scandi` user (it can `sudo systemctl restart` if you allow
that one command; see the next section).

### Passwordless restart

So `deploy.sh` doesn't prompt for sudo:

```bash
sudo visudo -f /etc/sudoers.d/scandi-deploy
# Add this single line:
scandi ALL=(root) NOPASSWD: /bin/systemctl restart scandi-wa-bot, /bin/journalctl -u scandi-wa-bot *
```

---

## 12. Monitoring

### `/v1/health` (preferred — when API is enabled)

The bot exposes an unauthenticated `GET /v1/health` endpoint that
reports both **socket connectivity** and **initial-sync completion**:

```bash
curl -fsS http://127.0.0.1:8787/v1/health
# {"status":"ok","sock_connected":true,"initial_sync_done":true,
#  "last_event_at":"2026-05-11T18:43:58Z","account_status":"active",
#  "account_label":"scandi-prod"}
```

Any external uptime service (UptimeRobot, Better Uptime, Healthchecks.io)
can poll this through your reverse proxy URL (if you set up §9) and
alert on:

- HTTP status != 200
- JSON `sock_connected` != true
- JSON `account_status` != `"active"`

UptimeRobot has a free "keyword" check that asserts a substring in the
response body — point it at `https://api.example.com/v1/health` and
require `"sock_connected":true`.

### Webhook delivery health

If you're running webhooks, monitor the `wa.webhook_deliveries` table
for buildup of `pending` rows or any `abandoned`:

```sql
-- "Are deliveries piling up?"
SELECT status, count(*) FROM wa.webhook_deliveries GROUP BY 1;

-- "What's been failing recently?"
SELECT id, event_type, attempts, last_status_code, last_error, inserted_at
FROM wa.webhook_deliveries
WHERE status IN ('failed', 'abandoned')
ORDER BY inserted_at DESC
LIMIT 20;

-- "Slow consumer? Look at attempt counts vs delivered."
SELECT
  s.url,
  count(*) FILTER (WHERE d.status='delivered') AS delivered,
  count(*) FILTER (WHERE d.status='pending')   AS pending,
  count(*) FILTER (WHERE d.status='abandoned') AS abandoned,
  avg(d.attempts) FILTER (WHERE d.status='delivered') AS avg_attempts
FROM wa.webhook_deliveries d
JOIN wa.webhook_subscriptions s ON s.id = d.subscription_id
WHERE d.inserted_at > NOW() - interval '1 day'
GROUP BY s.url;
```

### Health from Postgres (works regardless of API state)

The bot heartbeats `wa.sync_state.last_event_at` whenever an event is
processed. A simple uptime check:

```sql
SELECT
  account_id,
  status,
  last_event_at,
  NOW() - last_event_at AS lag
FROM wa.accounts a
JOIN wa.sync_state s ON s.account_id = a.id
WHERE label = 'scandi-prod';
```

If `lag > 5 minutes` and the chat is normally active, something's
wrong — check journald.

### Resource graphs

DigitalOcean's built-in droplet metrics (CPU, memory, bandwidth) are
free and adequate. Enable them at droplet creation, or under Insights
→ Monitoring after the fact.

### Service status one-liner

```bash
systemctl is-active scandi-wa-bot && \
  systemctl show scandi-wa-bot -p ActiveEnterTimestamp,MainPID,MemoryCurrent --no-pager
```

---

## 13. Backups

The droplet itself holds **no irreplaceable state**. What matters:

| Data                         | Where it lives          | Backup strategy                                |
| ---------------------------- | ----------------------- | ---------------------------------------------- |
| WA session credentials       | Supabase `wa.auth_*`    | Supabase auto-backup (free tier: 7 days)       |
| Messages, media metadata     | Supabase `wa.messages` etc. | Same                                       |
| AI processing results        | Supabase `wa.media_processing` | Same                                    |
| Original media files         | Firebase Storage bucket | Firebase has built-in 99.999999999% durability; enable Object Versioning if you want point-in-time |
| `.env`                       | Droplet `/opt/...`      | **You** — keep an encrypted copy in a password manager / 1Password / Bitwarden |
| `firebase-service-account.json` | Droplet `/opt/.../secrets/` | Same — store in your secrets manager     |

Verify Supabase backups are on:

> Supabase project → Database → Backups → "Daily backups" should show
> the last 7 days.

For higher durability, upgrade to a paid Supabase plan (Point-in-Time
Recovery) or run a nightly `pg_dump` to a DO Spaces bucket.

---

## 14. Updating Node / OS

```bash
# Once a month, or whenever you read a security advisory:
sudo apt update && sudo apt -y full-upgrade
sudo systemctl reboot                 # if kernel updated

# Once a year, when Node 20 EOLs (Apr 2026), bump to the next LTS:
sudo apt -y purge nodejs
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
cd /opt/scandi-wa-bot && sudo -u scandi npm ci && sudo -u scandi npm run build
sudo systemctl restart scandi-wa-bot
```

Unattended-upgrades from step 2 handles security patches nightly without
intervention.

---

## 15. Troubleshooting playbook

| Symptom                                                | Likely cause                                                                                | Fix                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Service flaps (start → exit → start loop)              | Bad `DATABASE_URL`, DB unreachable, **or** `API_ENABLED=true` with empty `API_AUTH_TOKEN`   | `journalctl -u scandi-wa-bot -n 50`; check Supabase status; URL-encode `@` in password; set a token or disable the API.          |
| Service runs but no messages persist                   | WhatsApp session expired                                                                    | Pair again (see step 8). `wa.accounts.status` is `logged_out`.                                                                   |
| `ENETUNREACH` on first boot                            | IPv6-only DNS for Supabase + ISP without IPv6                                               | Already mitigated in `src/db/client.ts` (forces IPv4). If still failing, `sudo sysctl net.ipv6.conf.all.disable_ipv6=1`.          |
| Media stuck `pending` forever                          | `FIREBASE_STORAGE_BUCKET` unset OR service account missing                                  | Check `.env`, restart, look for `media storage: firebase ready` in logs.                                                         |
| Gemini 429 `file_storage_bytes`                        | Files API quota (20 GiB) exhausted                                                          | Wait 48h for auto-expiry, or run a one-shot deletion script.                                                                     |
| Service uses 1.5 GB+ RAM                                | History sync running on a big account                                                       | Normal during initial sync. RAM drops back to ~400 MB once `initial_sync_done = true`.                                           |
| `systemctl restart` hangs ~90s                         | TCP keepalive on a closed socket                                                            | Cosmetic. systemd kills after `TimeoutStopSec` (default 90s). The next start is clean.                                           |
| API returns `401 unauthorized`                         | No `Authorization` header                                                                   | Send `Authorization: Bearer $API_AUTH_TOKEN`.                                                                                    |
| API returns `403 forbidden`                            | Wrong token                                                                                 | Verify the token matches `API_AUTH_TOKEN` byte-for-byte (no trailing newline).                                                   |
| API returns `503 service unavailable`                  | `sock_connected=false` (WA socket dropped)                                                  | Transient — retry with backoff. Check `/v1/health` for state. If persistent, check WA pairing.                                   |
| API not reachable at all                               | `API_ENABLED=false`, OR bound only to `127.0.0.1` when consumer is remote                   | Set `API_ENABLED=true`. For remote consumers, set up a reverse proxy (§9) — don't expose `:8787` directly.                       |
| Webhook never arrives at consumer                      | Sub inactive, wrong `event_types`, consumer URL unreachable, or HMAC mismatch on consumer side | `GET /v1/webhooks/:id` to inspect recent deliveries + errors. Check `wa.webhook_deliveries` directly (see SQL below).             |
| Webhooks arrive but signature fails                    | Consumer is re-serializing the JSON before verifying                                        | Use the **raw** request body for HMAC. See `docs/API.md` §5.5.                                                                   |
| `next_attempt_at` rows growing fast in `wa.webhook_deliveries` | Consumer is slow / failing                                                          | Inspect `last_error`; pause sub via `PATCH /v1/webhooks/:id {"active":false}` while you fix.                                     |
| Migrations missing fields (`column "seq" does not exist`) | Forgot to apply `0005_api_layer.sql` after upgrade                                       | Run `psql "$DATABASE_URL" -f db/migrations/0005_api_layer.sql`.                                                                  |
| Caddy / Nginx returns `502 bad gateway`                | API isn't actually listening on `127.0.0.1:8787`                                            | `curl -v http://127.0.0.1:8787/v1/health` from the droplet. If that fails, the bot didn't start the API — check `journalctl`.    |
| Lots of `messages.upsert` but no replies               | Hello-world handler removed (intentional)                                                   | Build your AI agent against the API (`docs/API.md` §11) — the bot itself doesn't auto-reply.                                     |

### Forensics — common SQL

```sql
-- "Has anything happened in the last 5 minutes?"
SELECT count(*) FROM wa.messages WHERE inserted_at > NOW() - interval '5 minutes';

-- "Is the media pipeline alive?"
SELECT download_status, count(*) FROM wa.media GROUP BY 1;

-- "Is the AI pipeline alive?"
SELECT processor, status, count(*) FROM wa.media_processing GROUP BY 1, 2;

-- "Are webhooks flowing?"
SELECT status, count(*) FROM wa.webhook_deliveries
WHERE inserted_at > NOW() - interval '1 hour'
GROUP BY 1;

-- "Show me the last 10 failed deliveries and why."
SELECT id, event_type, attempts, last_status_code, left(last_error, 80) AS err, next_attempt_at
FROM wa.webhook_deliveries
WHERE status IN ('failed','abandoned','pending') AND last_error IS NOT NULL
ORDER BY id DESC LIMIT 10;

-- "Manually re-enqueue a stuck delivery."
UPDATE wa.webhook_deliveries
   SET status='pending', next_attempt_at=NOW(), attempts=0, last_error=NULL
 WHERE id = <ID>;
```

---

## 16. Bonus: wire deploys to GitHub Actions (optional)

Once you have the manual deploy working, automate it. Add this workflow
under `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host:     ${{ secrets.DROPLET_HOST }}
          username: scandi
          key:      ${{ secrets.DROPLET_SSH_KEY }}
          script:   /opt/scandi-wa-bot/scripts/deploy.sh
```

Add `DROPLET_HOST` (the droplet IP) and `DROPLET_SSH_KEY` (a deploy
key with access only to that one box) as repo secrets. Every push to
`main` then deploys in <60s, with the same atomic
pull/build/restart flow.

---

## TL;DR — copy/paste path

```bash
# ── 1. host hardening (as root, once) ──────────────────────────────────
apt update && apt -y full-upgrade && apt -y install unattended-upgrades fail2ban ufw curl git
ufw default deny incoming && ufw default allow outgoing && ufw allow 22/tcp && ufw --force enable
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
useradd -m -s /bin/bash -G sudo scandi
cp -r /root/.ssh /home/scandi/ && chown -R scandi:scandi /home/scandi/.ssh && chmod 700 /home/scandi/.ssh
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/; s/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# ── 2. Node 20 (as scandi from here on) ────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs postgresql-client

# ── 3. clone + build ───────────────────────────────────────────────────
sudo mkdir -p /opt/scandi-wa-bot && sudo chown scandi:scandi /opt/scandi-wa-bot
cd /opt/scandi-wa-bot
git clone https://github.com/<you>/scandi-wa-bot.git .
npm ci && npm run build

# ── 4. config + secrets ────────────────────────────────────────────────
cp .env.example .env
nano .env
#  Required:
#   DATABASE_URL=postgresql://... (Supabase pooler, port 6543)
#   BROWSER_NAME=Desktop
#   WA_ACCOUNT_LABEL=scandi-prod
#   LOG_LEVEL=info
#  Recommended for AI:
#   FIREBASE_STORAGE_BUCKET=...
#   FIREBASE_SERVICE_ACCOUNT_PATH=secrets/firebase-service-account.json
#   GEMINI_API_KEY=...   ELEVENLABS_API_KEY=...   LLAMA_CLOUD_API_KEY=...
#  If using the API/webhooks:
#   API_ENABLED=true
#   API_AUTH_TOKEN=$(openssl rand -hex 32)

mkdir -p secrets && nano secrets/firebase-service-account.json
chmod 600 .env secrets/firebase-service-account.json

# ── 5. apply DB migrations (one-time, idempotent) ──────────────────────
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

# ── 6. systemd ─────────────────────────────────────────────────────────
# Copy the full unit body from §7 of this doc into the file below:
sudo nano /etc/systemd/system/scandi-wa-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now scandi-wa-bot
sudo journalctl -u scandi-wa-bot -f

# ── 7. pair WhatsApp ───────────────────────────────────────────────────
#  Easiest: run `npm run dev` on your laptop ONCE with the same
#  DATABASE_URL, scan QR, wait for "connection opened", Ctrl+C.
#  The droplet picks the session up automatically on next start.

# ── 8. (optional) expose API via HTTPS — see §9 ────────────────────────
#  sudo apt -y install caddy
#  sudo nano /etc/caddy/Caddyfile     # one stanza, see §9.2
#  sudo systemctl reload caddy

# ── 9. smoke test ──────────────────────────────────────────────────────
curl http://127.0.0.1:8787/v1/health        # sock_connected:true
curl -H "Authorization: Bearer $API_AUTH_TOKEN" http://127.0.0.1:8787/v1/me
```

After this, the droplet is steady-state — restart-on-fail, auto-reconnect
on WhatsApp drops, journald-logged, host-hardened, replaceable. Pull
updates with the deploy script in §11. Build AI consumers against the
API following `docs/API.md`.
