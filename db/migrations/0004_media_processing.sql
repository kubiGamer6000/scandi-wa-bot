-- 0004_media_processing.sql
--
-- Second Postgres-backed work queue: AI processing of downloaded media.
-- After wa.media reaches download_status='done', a processing job is
-- enqueued here for the appropriate AI service (Gemini, ElevenLabs, LlamaParse).

CREATE TABLE wa.media_processing (
  id              BIGSERIAL PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES wa.accounts(id) ON DELETE CASCADE,
  media_id        BIGINT NOT NULL REFERENCES wa.media(id) ON DELETE CASCADE,
  chat_jid        TEXT NOT NULL,
  message_id      TEXT NOT NULL,

  -- What kind of processing
  processor       TEXT NOT NULL,   -- gemini_video, gemini_image, elevenlabs_audio, llamaparse_document
  model           TEXT NOT NULL,   -- gemini-2.5-flash, scribe_v2, agentic, etc.
  prompt          TEXT,            -- the actual prompt sent (NULL for audio/doc)

  -- GCS input (denormalized from wa.media for the claim query)
  gcs_bucket      TEXT NOT NULL,
  gcs_object      TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT,

  -- Queue columns (same FOR UPDATE SKIP LOCKED pattern as wa.media)
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until     TIMESTAMPTZ,
  worker_id       TEXT,

  -- Result
  result_text     TEXT,            -- transcript / description / markdown
  result_meta     JSONB,           -- token counts, model version, page count, etc.
  processing_ms   INT,

  completed_at    TIMESTAMPTZ,
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claim index: drives the worker's FOR UPDATE SKIP LOCKED query.
CREATE INDEX media_processing_ready_idx
  ON wa.media_processing (next_attempt_at, account_id)
  WHERE status = 'pending';

-- Lease reaper: find abandoned in-progress rows.
CREATE INDEX media_processing_lease_idx
  ON wa.media_processing (lease_until)
  WHERE status = 'in_progress' AND lease_until IS NOT NULL;

-- Lookup by media row (for joining back to wa.media).
CREATE INDEX media_processing_media_idx
  ON wa.media_processing (media_id);

-- Prevent duplicate processing jobs for the same media.
CREATE UNIQUE INDEX media_processing_unique_idx
  ON wa.media_processing (media_id, processor);

-- updated_at trigger (reuse the existing trigger function).
CREATE TRIGGER touch_media_processing_updated_at
  BEFORE UPDATE ON wa.media_processing
  FOR EACH ROW EXECUTE FUNCTION wa.touch_updated_at();
