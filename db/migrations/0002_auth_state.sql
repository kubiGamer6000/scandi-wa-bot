-- 0002_auth_state.sql
--
-- Production-ready Postgres-backed Baileys auth state.
-- Replaces the file-based useMultiFileAuthState (which Baileys explicitly
-- warns against using in production due to per-key file IO).
--
-- Two tables, both scoped by account_id so a single DB hosts many bots:
--
--   wa.auth_creds : one row per account, holds the AuthenticationCreds
--                   blob (BufferJSON-encoded). Updated whenever Baileys
--                   emits creds.update.
--
--   wa.auth_keys  : Signal protocol keys, keyed by (type, id). Holds
--                   pre-keys, sessions, sender keys, app-state-sync-keys,
--                   lid-mappings, device-lists, tctokens, etc.
--                   Bulk SELECT/UPSERT/DELETE per Baileys batch.
--
-- Bytes are persisted as JSONB via Baileys' BufferJSON.replacer (Buffer ↔
-- {"type":"Buffer","data":"<base64>"}). This is exactly what the file-based
-- impl does — same semantics, no IO storm.

CREATE TABLE wa.auth_creds (
  account_id  UUID PRIMARY KEY REFERENCES wa.accounts(id) ON DELETE CASCADE,
  creds       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wa.auth_creds ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.auth_creds IS 'Baileys AuthenticationCreds (BufferJSON-encoded). One row per WA account.';

CREATE TRIGGER auth_creds_touch_updated_at
  BEFORE UPDATE ON wa.auth_creds
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();

CREATE TABLE wa.auth_keys (
  account_id  UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  id          TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, type, id)
);
CREATE INDEX auth_keys_account_type_idx ON wa.auth_keys (account_id, type);
ALTER TABLE wa.auth_keys ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.auth_keys IS
  'Signal keys (BufferJSON-encoded). type ∈ pre-key, session, sender-key, '
  'sender-key-memory, app-state-sync-key, app-state-sync-version, lid-mapping, '
  'device-list, tctoken, identity-key.';

CREATE TRIGGER auth_keys_touch_updated_at
  BEFORE UPDATE ON wa.auth_keys
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
