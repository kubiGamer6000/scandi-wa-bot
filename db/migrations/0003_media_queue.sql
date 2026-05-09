-- 0003_media_queue.sql
--
-- Turn wa.media into a Postgres-backed work queue for the media downloader.
-- We already have download_status / download_error / download_attempts /
-- gcs_bucket / gcs_object — this migration adds the columns the worker
-- needs for FOR UPDATE SKIP LOCKED claim semantics, exponential retry,
-- and crash recovery via leases.

-- ───────────────────────── new columns ─────────────────────────
ALTER TABLE wa.media
  -- When this row is eligible to be picked up next. Initially NOW(), bumped
  -- by the worker on transient failure. Indexed below for fast claim.
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when a worker claims the row; if a worker dies mid-job, the lease
  -- expires and a reaper / next claimer can take over.
  ADD COLUMN IF NOT EXISTS lease_until      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_id        TEXT,
  ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ,
  -- Verified post-download size. file_length is the encrypted-blob length
  -- from the WA proto; this is what we actually wrote to storage.
  ADD COLUMN IF NOT EXISTS size_bytes       BIGINT,
  -- Final mime, possibly sniffed if WA didn't tell us.
  ADD COLUMN IF NOT EXISTS content_type     TEXT,
  -- Token-bearing public download URL from Firebase (getDownloadURL output).
  -- Optional — the (gcs_bucket, gcs_object) pair is canonical.
  ADD COLUMN IF NOT EXISTS gcs_url          TEXT;

COMMENT ON COLUMN wa.media.next_attempt_at IS 'When this media row is eligible for the next download attempt. Bumped on transient failure.';
COMMENT ON COLUMN wa.media.lease_until     IS 'NULL when not claimed; otherwise the deadline by which the worker must complete or extend.';
COMMENT ON COLUMN wa.media.worker_id       IS 'Identifier of the worker holding the lease (debug aid).';
COMMENT ON COLUMN wa.media.completed_at    IS 'When the upload finished (download_status = ''done'').';
COMMENT ON COLUMN wa.media.size_bytes      IS 'Verified post-download size in bytes.';
COMMENT ON COLUMN wa.media.content_type    IS 'Final content-type used for the storage object.';
COMMENT ON COLUMN wa.media.gcs_url         IS 'Token-bearing Firebase download URL. (gcs_bucket, gcs_object) is canonical.';

-- ───────────────────────── claim index ─────────────────────────
-- Partial index drives the worker's claim query:
--   SELECT id FROM wa.media WHERE download_status='pending' AND next_attempt_at <= NOW()
--     ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT N
-- The WHERE filters only "ready to run" rows so the index stays tiny.
CREATE INDEX IF NOT EXISTS media_ready_idx
  ON wa.media (next_attempt_at, account_id)
  WHERE download_status = 'pending';

-- Reaper helper: leases that have expired (worker probably crashed).
CREATE INDEX IF NOT EXISTS media_lease_expired_idx
  ON wa.media (lease_until)
  WHERE download_status = 'in_progress' AND lease_until IS NOT NULL;
