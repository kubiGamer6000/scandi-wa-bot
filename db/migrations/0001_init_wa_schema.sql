-- 0001_init_wa_schema.sql
--
-- Initial schema for the Scandi WhatsApp message store.
--
-- Design notes:
--   * Everything lives under the `wa` schema, kept private (not exposed via
--     PostgREST). RLS is enabled on every table as defense-in-depth, but no
--     policies are defined because the bot connects with a privileged role
--     that bypasses RLS.
--   * All tables include `account_id UUID` so multiple WhatsApp accounts can
--     share one DB. Composite PKs are `(account_id, ...)`.
--   * `wa.messages.raw_message` is nullable: if we observe a delete before the
--     original message arrived, we still create a tombstone row.
--   * Trigram index on message text powers fuzzy search later.

CREATE SCHEMA IF NOT EXISTS wa;
GRANT USAGE ON SCHEMA wa TO postgres;
COMMENT ON SCHEMA wa IS 'WhatsApp message store. Private — not exposed via PostgREST.';

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ───────────────────────── accounts ─────────────────────────
CREATE TABLE wa.accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label        TEXT NOT NULL UNIQUE,
  self_pn_jid  TEXT,
  self_lid_jid TEXT,
  push_name    TEXT,
  paired_at    TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','logged_out','paused')),
  auth_dir     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wa.accounts ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.accounts IS 'One row per linked WhatsApp account. Every other wa.* table is scoped by account_id.';

-- ───────────────────────── lid_mappings ─────────────────────────
CREATE TABLE wa.lid_mappings (
  account_id   UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  lid          TEXT NOT NULL,
  pn           TEXT NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, lid)
);
CREATE INDEX lid_mappings_pn_idx ON wa.lid_mappings (account_id, pn);
ALTER TABLE wa.lid_mappings ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.lid_mappings IS 'WhatsApp LID ↔ PN mappings observed via lid-mapping.update events and history sync.';

-- ───────────────────────── contacts ─────────────────────────
CREATE TABLE wa.contacts (
  account_id    UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  jid           TEXT NOT NULL,
  pn            TEXT,
  lid           TEXT,
  name          TEXT,
  push_name     TEXT,
  business_info JSONB,
  is_business   BOOLEAN NOT NULL DEFAULT FALSE,
  raw           JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, jid)
);
CREATE INDEX contacts_pn_idx ON wa.contacts (account_id, pn) WHERE pn IS NOT NULL;
CREATE INDEX contacts_lid_idx ON wa.contacts (account_id, lid) WHERE lid IS NOT NULL;
ALTER TABLE wa.contacts ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.contacts IS 'WhatsApp contacts. JID may be PN form (...@s.whatsapp.net) or LID (...@lid).';

-- ───────────────────────── chats ─────────────────────────
CREATE TABLE wa.chats (
  account_id            UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  jid                   TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('dm','group','lid','broadcast','newsletter','status','system')),
  subject               TEXT,
  description           TEXT,
  owner_jid             TEXT,
  is_default_subgroup   BOOLEAN,
  suspended             BOOLEAN,
  pn_jid                TEXT,
  account_lid           TEXT,
  contact_primary_identity_key BYTEA,
  share_own_pn          BOOLEAN,
  lid_origin_type       TEXT,
  unread_count          INT,
  unread_mention_count  INT,
  marked_as_unread      BOOLEAN,
  archived              BOOLEAN,
  read_only             BOOLEAN,
  not_spam              BOOLEAN,
  ephemeral_seconds     INT,
  ephemeral_set_ts      TIMESTAMPTZ,
  conversation_ts       TIMESTAMPTZ,
  oldest_known_ts       TIMESTAMPTZ,
  history_complete      BOOLEAN NOT NULL DEFAULT FALSE,
  cleared_at            TIMESTAMPTZ,
  raw                   JSONB NOT NULL,
  inserted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, jid)
);
CREATE INDEX chats_recent_idx ON wa.chats (account_id, conversation_ts DESC NULLS LAST);
CREATE INDEX chats_type_idx ON wa.chats (account_id, type);
ALTER TABLE wa.chats ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.chats IS 'WhatsApp chats. type partitions by JID-suffix family.';

-- ───────────────────────── group_participants ─────────────────────────
CREATE TABLE wa.group_participants (
  account_id     UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  group_jid      TEXT NOT NULL,
  participant    TEXT NOT NULL,
  participant_pn TEXT,
  role           TEXT,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at        TIMESTAMPTZ,
  PRIMARY KEY (account_id, group_jid, participant),
  FOREIGN KEY (account_id, group_jid) REFERENCES wa.chats(account_id, jid) ON DELETE CASCADE
);
ALTER TABLE wa.group_participants ENABLE ROW LEVEL SECURITY;

-- ───────────────────────── messages ─────────────────────────
CREATE TABLE wa.messages (
  account_id        UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  chat_jid          TEXT NOT NULL,
  id                TEXT NOT NULL,
  from_me           BOOLEAN NOT NULL,
  participant       TEXT,
  sender_pn         TEXT,
  remote_jid_alt    TEXT,
  ts                TIMESTAMPTZ NOT NULL,
  status            TEXT,
  message_addressing_mode TEXT,
  push_name         TEXT,
  broadcast         BOOLEAN,
  message_type      TEXT,
  is_protocol       BOOLEAN NOT NULL DEFAULT FALSE,
  text              TEXT,
  caption           TEXT,
  forwarded         BOOLEAN,
  forward_score     INT,
  quoted_msg_id     TEXT,
  quoted_participant TEXT,
  quoted_text       TEXT,
  edit_count        INT NOT NULL DEFAULT 0,
  last_edited_at    TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  deleted_by_jid    TEXT,
  deletion_reason   TEXT,
  tombstone         BOOLEAN NOT NULL DEFAULT FALSE,
  raw_message       JSONB,
  raw_envelope      JSONB NOT NULL,
  inserted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, chat_jid, id),
  FOREIGN KEY (account_id, chat_jid) REFERENCES wa.chats(account_id, jid) ON DELETE CASCADE
);
CREATE INDEX messages_chat_ts_idx ON wa.messages (account_id, chat_jid, ts DESC);
CREATE INDEX messages_account_ts_idx ON wa.messages (account_id, ts DESC);
CREATE INDEX messages_participant_idx ON wa.messages (account_id, participant) WHERE participant IS NOT NULL;
CREATE INDEX messages_quoted_idx ON wa.messages (account_id, chat_jid, quoted_msg_id) WHERE quoted_msg_id IS NOT NULL;
CREATE INDEX messages_text_trgm_idx ON wa.messages USING GIN (text extensions.gin_trgm_ops) WHERE text IS NOT NULL;
CREATE INDEX messages_alive_idx ON wa.messages (account_id, chat_jid, ts DESC) WHERE deleted_at IS NULL;
ALTER TABLE wa.messages ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.messages IS 'WhatsApp messages. raw_message=NULL means we saw a delete before the original; raw_envelope is always present.';

-- ───────────────────────── message_edits ─────────────────────────
CREATE TABLE wa.message_edits (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  chat_jid      TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  version       INT NOT NULL,
  text          TEXT,
  caption       TEXT,
  message_type  TEXT,
  raw_message   JSONB NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, chat_jid, message_id, version),
  FOREIGN KEY (account_id, chat_jid, message_id) REFERENCES wa.messages(account_id, chat_jid, id) ON DELETE CASCADE
);
CREATE INDEX message_edits_lookup_idx ON wa.message_edits (account_id, chat_jid, message_id, version DESC);
ALTER TABLE wa.message_edits ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.message_edits IS 'Snapshot of each previous version of a message. Current version lives on wa.messages.';

-- ───────────────────────── reactions ─────────────────────────
CREATE TABLE wa.reactions (
  account_id    UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  chat_jid      TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  actor_jid     TEXT NOT NULL,
  emoji         TEXT,
  ts            TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, chat_jid, message_id, actor_jid),
  FOREIGN KEY (account_id, chat_jid, message_id) REFERENCES wa.messages(account_id, chat_jid, id) ON DELETE CASCADE
);
ALTER TABLE wa.reactions ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.reactions IS 'Current reaction state per (msg, actor). emoji=NULL means the reaction was removed.';

-- ───────────────────────── media ─────────────────────────
CREATE TABLE wa.media (
  id              BIGSERIAL PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  chat_jid        TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  media_type      TEXT NOT NULL CHECK (media_type IN ('image','video','audio','document','sticker','ptv','gif')),
  mime_type       TEXT,
  file_name       TEXT,
  file_length     BIGINT,
  width           INT,
  height          INT,
  duration_seconds INT,
  page_count      INT,
  media_key       BYTEA,
  file_sha256     BYTEA,
  file_enc_sha256 BYTEA,
  direct_path     TEXT,
  url             TEXT,
  thumbnail       BYTEA,
  jpeg_thumbnail  BYTEA,
  caption         TEXT,
  download_status TEXT NOT NULL DEFAULT 'pending' CHECK (download_status IN ('pending','in_progress','done','failed','expired','skipped')),
  download_error  TEXT,
  download_attempts INT NOT NULL DEFAULT 0,
  gcs_bucket      TEXT,
  gcs_object      TEXT,
  local_path      TEXT,
  is_voice_note   BOOLEAN,
  waveform        BYTEA,
  raw             JSONB NOT NULL,
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, chat_jid, message_id),
  FOREIGN KEY (account_id, chat_jid, message_id) REFERENCES wa.messages(account_id, chat_jid, id) ON DELETE CASCADE
);
CREATE INDEX media_pending_idx ON wa.media (download_status, inserted_at) WHERE download_status IN ('pending','failed');
CREATE INDEX media_type_idx ON wa.media (account_id, media_type);
ALTER TABLE wa.media ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.media IS 'Per-message media metadata. The downloader worker fills gcs_bucket/gcs_object once persisted.';

-- ───────────────────────── message_receipts ─────────────────────────
CREATE TABLE wa.message_receipts (
  account_id    UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  chat_jid      TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  user_jid      TEXT NOT NULL,
  receipt_type  TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, chat_jid, message_id, user_jid, receipt_type),
  FOREIGN KEY (account_id, chat_jid, message_id) REFERENCES wa.messages(account_id, chat_jid, id) ON DELETE CASCADE
);
ALTER TABLE wa.message_receipts ENABLE ROW LEVEL SECURITY;

-- ───────────────────────── labels ─────────────────────────
CREATE TABLE wa.labels (
  account_id    UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  name          TEXT,
  color         INT,
  predefined_id INT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  raw           JSONB,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, id)
);
ALTER TABLE wa.labels ENABLE ROW LEVEL SECURITY;

CREATE TABLE wa.label_associations (
  account_id    UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  label_id      TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('chat','message')),
  chat_jid      TEXT NOT NULL,
  -- Empty string represents "chat-level association" (no specific message).
  -- We use '' instead of NULL so the column can participate in the PK.
  message_id    TEXT NOT NULL DEFAULT '',
  raw           JSONB,
  PRIMARY KEY (account_id, label_id, type, chat_jid, message_id)
);
ALTER TABLE wa.label_associations ENABLE ROW LEVEL SECURITY;

-- ───────────────────────── settings ─────────────────────────
CREATE TABLE wa.settings (
  account_id  UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, key)
);
ALTER TABLE wa.settings ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.settings IS 'Per-account WhatsApp settings (push name, ephemeral defaults, app-state collections, etc.).';

-- ───────────────────────── sync_state ─────────────────────────
CREATE TABLE wa.sync_state (
  account_id           UUID PRIMARY KEY REFERENCES wa.accounts(id) ON DELETE CASCADE,
  history_received_at  TIMESTAMPTZ,
  history_progress_pct INT,
  history_chunk_order  TEXT,
  history_sync_type    TEXT,
  is_latest            BOOLEAN,
  initial_sync_done    BOOLEAN NOT NULL DEFAULT FALSE,
  last_event_at        TIMESTAMPTZ,
  raw                  JSONB,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wa.sync_state ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.sync_state IS 'Per-account sync watermarks; one row per account.';

-- ───────────────────────── event_log ─────────────────────────
CREATE TABLE wa.event_log (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  payload     JSONB NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX event_log_account_event_ts_idx ON wa.event_log (account_id, event, ts DESC);
ALTER TABLE wa.event_log ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.event_log IS 'Append-only catchall for unmodeled / debug events. Truncate freely.';

-- ───────────────────────── triggers ─────────────────────────
CREATE OR REPLACE FUNCTION wa.touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER chats_touch_updated_at
  BEFORE UPDATE ON wa.chats
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
CREATE TRIGGER messages_touch_updated_at
  BEFORE UPDATE ON wa.messages
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
CREATE TRIGGER media_touch_updated_at
  BEFORE UPDATE ON wa.media
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
CREATE TRIGGER labels_touch_updated_at
  BEFORE UPDATE ON wa.labels
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
CREATE TRIGGER settings_touch_updated_at
  BEFORE UPDATE ON wa.settings
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
CREATE TRIGGER sync_state_touch_updated_at
  BEFORE UPDATE ON wa.sync_state
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
