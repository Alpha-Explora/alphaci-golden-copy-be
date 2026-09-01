-- Rollback for 20260828000000_outbox_reliability.sql
--
-- This rollback fails closed when reliability diagnostics exist. Dropping the
-- quarantine columns would otherwise erase the failure evidence needed to
-- decide whether a row is safe to replay. Export/replay or otherwise resolve
-- those rows with an approved operator procedure before retrying the rollback.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM platform.outbox_events
    WHERE status = 'quarantined'
       OR last_error IS NOT NULL
       OR quarantined_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback refused: outbox retry or quarantine diagnostics would be discarded; export and resolve those rows before retrying';
  END IF;
END
$$;

-- Leases are transient ownership metadata. Clearing them is safe once the
-- diagnostic preflight above has passed and makes pending rows reclaimable by
-- the previous relay implementation.
UPDATE platform.outbox_events
SET available_at = COALESCE(available_at, NOW()),
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = NOW()
WHERE available_at IS NULL
   OR lease_token IS NOT NULL
   OR lease_expires_at IS NOT NULL;

-- The legacy table required a non-null availability timestamp. Restore a
-- usable value before restoring that constraint.
UPDATE platform.outbox_events
SET available_at = COALESCE(available_at, NOW())
WHERE available_at IS NULL;

DROP INDEX IF EXISTS platform.idx_platform_outbox_pending_available;
DROP INDEX IF EXISTS platform.idx_platform_outbox_quarantined;

ALTER TABLE platform.outbox_events
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS quarantined_at,
  DROP COLUMN IF EXISTS lease_token,
  DROP COLUMN IF EXISTS lease_expires_at;

ALTER TABLE platform.outbox_events
  ALTER COLUMN available_at SET NOT NULL;

COMMIT;
