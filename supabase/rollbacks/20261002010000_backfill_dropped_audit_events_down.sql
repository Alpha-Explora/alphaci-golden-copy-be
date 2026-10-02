-- Rollback: 20261002010000_backfill_dropped_audit_events
-- Removes the rows the backfill inserted (they are the only rows with an
-- outbox_event_id; the source events remain in platform.outbox_events) and the
-- column and index the migration added.
BEGIN;

DELETE FROM audit.audit_events WHERE outbox_event_id IS NOT NULL;

DROP INDEX IF EXISTS audit.idx_audit_events_delivery_project_created;

ALTER TABLE audit.audit_events
  DROP COLUMN IF EXISTS outbox_event_id;

COMMIT;
