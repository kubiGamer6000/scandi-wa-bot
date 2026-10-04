-- 0006_notify_api.sql
--
-- Scoped API keys + a send-only notification endpoint (POST /v1/notify).
--
--   1. wa.api_keys — hashed keys for external apps (e.g. the editor app).
--      A key carries scopes; the `notify` scope can only send notifications,
--      never read chats, download media or manage webhooks. The master
--      API_AUTH_TOKEN keeps full access but only from the droplet itself.
--   2. wa.notifications — one row per notify request: audit trail,
--      idempotency (api_key_id + idempotency_key) and daily rate limits.

-- ───────────────────────── api_keys ─────────────────────────
CREATE TABLE IF NOT EXISTS wa.api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  -- First characters of the key (e.g. "wak_3f9a1c"), for identification in
  -- logs and listings. The full key is shown once at creation, never stored.
  key_prefix      TEXT NOT NULL,
  -- sha256(key), hex. Keys are 256-bit random, so a fast hash is sufficient.
  key_hash        TEXT NOT NULL UNIQUE,
  scopes          TEXT[] NOT NULL DEFAULT ARRAY['notify']::TEXT[],
  rate_per_minute INT NOT NULL DEFAULT 30,
  rate_per_day    INT NOT NULL DEFAULT 1000,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
ALTER TABLE wa.api_keys ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.api_keys IS
  'Scoped API keys for external apps. Only sha256 hashes are stored. Manage with `npm run api-key`.';

-- ───────────────────────── notifications ─────────────────────────
CREATE TABLE IF NOT EXISTS wa.notifications (
  id               BIGSERIAL PRIMARY KEY,
  account_id       UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  api_key_id       UUID NOT NULL REFERENCES wa.api_keys(id) ON DELETE CASCADE,
  idempotency_key  TEXT,
  to_input         TEXT NOT NULL,           -- what the caller sent
  to_jid           TEXT,                    -- resolved WhatsApp JID
  text_chars       INT NOT NULL,
  status           TEXT NOT NULL,           -- sent | failed
  error            TEXT,
  wa_message_id    TEXT,
  seq              BIGINT,                  -- wa.messages.seq of the sent message
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wa.notifications ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.notifications IS
  'Audit log of POST /v1/notify requests. Also backs idempotency and daily rate limits.';

-- Idempotency: one row per (key, idempotency_key). NULL keys don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_idem_idx
  ON wa.notifications (api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Daily rate limits + per-key history listings.
CREATE INDEX IF NOT EXISTS notifications_key_time_idx
  ON wa.notifications (api_key_id, created_at DESC);

-- Per-recipient limits.
CREATE INDEX IF NOT EXISTS notifications_to_time_idx
  ON wa.notifications (to_jid, created_at DESC);
