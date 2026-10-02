-- Rollback: 20261002020000_audit_github_activity
-- Removes the rows the GitHub sync ingested (the only rows with an
-- external_id; the events remain on GitHub for 90 days and are re-ingested if
-- the migration is applied again), the sync bookkeeping table, and the column
-- and index the migration added.
BEGIN;

DELETE FROM audit.audit_events WHERE external_id IS NOT NULL;

DROP TABLE IF EXISTS audit.github_event_syncs;

DROP INDEX IF EXISTS audit.uq_audit_events_external_id;

ALTER TABLE audit.audit_events
  DROP COLUMN IF EXISTS external_id;

COMMIT;
