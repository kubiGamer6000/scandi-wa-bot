-- 0007_usernames.sql
--
-- WhatsApp usernames → the account they belong to.
--
-- Since WhatsApp introduced usernames, people can hide their phone number;
-- the editor app may then only know their @username. POST /v1/notify accepts
-- a username and resolves it to a JID (preferably the person's LID). Every
-- resolution is recorded here so it is asked of WhatsApp at most once, and
-- usernames WhatsApp reveals on its own (contact sync, incoming messages)
-- are recorded too, so someone who has messaged the bot resolves without a
-- lookup at all.
--
-- Additive and idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS wa.usernames (
  account_id     UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  username       TEXT NOT NULL,           -- lowercase, without the leading '@'
  jid            TEXT NOT NULL,           -- '…@lid' preferred, else '…@s.whatsapp.net'
  source         TEXT NOT NULL,           -- usync | contact | message
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, username)
);
ALTER TABLE wa.usernames ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE wa.usernames IS
  'WhatsApp username → JID, from username lookups, contact sync and incoming messages. Backs @username recipients in POST /v1/notify.';

CREATE INDEX IF NOT EXISTS usernames_jid_idx ON wa.usernames (account_id, jid);
