-- Harden the single platform outbox relay without introducing a broker.
-- Delivery remains at-least-once: failed handlers retry with backoff and then
-- become visible quarantine records for an operator to inspect/replay.
BEGIN;

ALTER TABLE platform.outbox_events
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;

-- A quarantined row is excluded by status, so it must not carry a misleading
-- next-attempt timestamp. Existing pending rows retain their current default.
ALTER TABLE platform.outbox_events
  ALTER COLUMN available_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_platform_outbox_pending_available
  ON platform.outbox_events (available_at, created_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_platform_outbox_quarantined
  ON platform.outbox_events (quarantined_at, created_at, id)
  WHERE status = 'quarantined';

COMMENT ON COLUMN platform.outbox_events.last_error IS
  'Redacted summary of the latest handler failure; retained for retry/quarantine operations.';

COMMENT ON COLUMN platform.outbox_events.quarantined_at IS
  'Time at which retry exhaustion moved the event out of the pending queue.';

COMMIT;
