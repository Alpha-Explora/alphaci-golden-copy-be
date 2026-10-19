-- Rollback for 20261021010000_qa_po_acceptance.sql.
--
-- Dropping the columns forgets which items a Product owner accepted; Merge to
-- main then no longer waits for them. Nothing else depends on the columns.

BEGIN;

ALTER TABLE projects.qa_run_items
  DROP COLUMN IF EXISTS po_at,
  DROP COLUMN IF EXISTS po_by_login,
  DROP COLUMN IF EXISTS po_by,
  DROP COLUMN IF EXISTS po_status;

COMMIT;
