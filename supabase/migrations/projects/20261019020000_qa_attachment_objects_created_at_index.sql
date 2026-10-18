-- Index for the orphaned-bytes sweep (WP-A follow-up).
--
-- A run or project delete cascades the attachment metadata rows but not their
-- bytes in projects.qa_attachment_objects. The api sweeps those orphans on a
-- timer: rows older than a grace period with no projects.qa_run_item_attachments
-- row at the same storage_path, oldest first, in batches. The anti-join uses the
-- UNIQUE constraint on qa_run_item_attachments.storage_path; this index serves
-- the age filter and the oldest-first order, so a pass stops at its batch
-- instead of scanning the whole bytea table.
--
-- Additive only: one index, no change to rows or constraints. Safe to apply
-- before or after the backend that runs the sweep deploys.

CREATE INDEX IF NOT EXISTS idx_qa_attachment_objects_created_at
  ON projects.qa_attachment_objects (created_at);
