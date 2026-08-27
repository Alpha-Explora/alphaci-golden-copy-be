-- Rollback for 20260828000000_outbox_reliability.sql
--
-- LOSSY: this removes retry/quarantine diagnostics. Any rows that are
-- quarantined or have an error message must be investigated or replayed
-- before running this rollback; the legacy schema has nowhere to retain that
-- information.
BEGIN;

-- The legacy table required a non-null availability timestamp. Restore a
-- usable value before restoring that constraint.
UPDATE platform.outbox_events
SET available_at = COALESCE(available_at, NOW())
WHERE available_at IS NULL;

DROP INDEX IF EXISTS platform.idx_platform_outbox_pending_available;
DROP INDEX IF EXISTS platform.idx_platform_outbox_quarantined;

ALTER TABLE platform.outbox_events
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS quarantined_at;

ALTER TABLE platform.outbox_events
  ALTER COLUMN available_at SET NOT NULL;

COMMIT;
