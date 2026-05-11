-- 0005_api_layer.sql
--
-- HTTP API layer support:
--   1. Add a globally-unique `seq` bigserial to wa.messages so the API can
--      expose short, opaque message ids (e.g. `/v1/messages/42173`).
--   2. Create wa.webhook_subscriptions for DB-stored webhook configs.
--   3. Create wa.webhook_deliveries as a Postgres-backed durable delivery
--      queue using the same FOR UPDATE SKIP LOCKED pattern as wa.media
--      and wa.media_processing.

-- ───────────────────────── seq on messages ─────────────────────────
-- bigserial implicitly creates a unique sequence and backfills existing rows
-- with monotonically increasing values. We add a UNIQUE constraint so it is
-- safe to look up a message by `seq` alone (no need for account_id in URLs)
-- while still being efficient for per-account iteration via the composite idx.
ALTER TABLE wa.messages ADD COLUMN seq BIGSERIAL;
ALTER TABLE wa.messages ADD CONSTRAINT messages_seq_unique UNIQUE (seq);
CREATE INDEX messages_account_seq_idx ON wa.messages (account_id, seq DESC);

-- ───────────────────────── webhook_subscriptions ─────────────────────────
CREATE TABLE wa.webhook_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  secret       TEXT NOT NULL,
  event_types  TEXT[] NOT NULL DEFAULT ARRAY[
    'message.received',
    'message.edited',
    'message.deleted',
    'message.reacted',
    'message.processed'
  ],
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wa.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.webhook_subscriptions IS
  'Outbound webhook destinations. Each row is a consumer (AI agent etc.) that wants events POSTed to it.';

CREATE INDEX webhook_subs_active_idx ON wa.webhook_subscriptions (account_id) WHERE active;

CREATE TRIGGER webhook_subs_touch_updated_at
  BEFORE UPDATE ON wa.webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();

-- ───────────────────────── webhook_deliveries ─────────────────────────
CREATE TABLE wa.webhook_deliveries (
  id                BIGSERIAL PRIMARY KEY,
  subscription_id   UUID NOT NULL REFERENCES wa.webhook_subscriptions(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,

  -- Queue columns (same FOR UPDATE SKIP LOCKED pattern as wa.media_processing).
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|delivered|failed|abandoned
  attempts          INT  NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until       TIMESTAMPTZ,
  worker_id         TEXT,

  -- Delivery result
  last_status_code  INT,
  last_error        TEXT,
  delivered_at      TIMESTAMPTZ,

  inserted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wa.webhook_deliveries ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.webhook_deliveries IS
  'Durable outbound webhook delivery queue. Worker drains via FOR UPDATE SKIP LOCKED with exponential backoff.';

-- Claim index: drives the worker's FOR UPDATE SKIP LOCKED query.
CREATE INDEX webhook_deliv_ready_idx
  ON wa.webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';

-- Lease reaper: find abandoned in-progress rows.
CREATE INDEX webhook_deliv_lease_idx
  ON wa.webhook_deliveries (lease_until)
  WHERE status = 'in_progress' AND lease_until IS NOT NULL;

-- Lookup by subscription (for ops queries like "delivery health per consumer").
CREATE INDEX webhook_deliv_sub_idx ON wa.webhook_deliveries (subscription_id, inserted_at DESC);

CREATE TRIGGER webhook_deliv_touch_updated_at
  BEFORE UPDATE ON wa.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
