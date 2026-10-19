-- Product owner acceptance: after the QA Team signs a Project run off, the
-- Product owner checks every story and item. Passing one records who and when
-- here; failing one reopens the run and returns the story to the Developers
-- as Failed (a QA status write), so nothing beyond "passed" is stored.
-- Merge to main waits until every item of the signed-off run is accepted.
--
-- Additive only: four new columns with a default, so code deployed before
-- this change keeps working against it. Every existing item starts pending.
--
-- Model (ADR-0014, amendment 12):
--   qa_run_items.po_status    'pending' | 'passed'
--   qa_run_items.po_by        the Product owner (or admin) who passed it
--   qa_run_items.po_by_login  their login at the time
--   qa_run_items.po_at        when
-- A QA status write on the item resets all four (the backend does it in the
-- same UPDATE), so an acceptance always refers to QA's current result.
--
-- Cross-context note: po_by is a plain UUID with no foreign key, the same
-- pattern as verified_by.

ALTER TABLE projects.qa_run_items
  ADD COLUMN IF NOT EXISTS po_status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT qa_run_items_po_status_chk CHECK (po_status IN ('pending', 'passed')),
  ADD COLUMN IF NOT EXISTS po_by UUID NULL,
  ADD COLUMN IF NOT EXISTS po_by_login TEXT NULL,
  ADD COLUMN IF NOT EXISTS po_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN projects.qa_run_items.po_status IS
  'Product owner acceptance after QA sign-off: pending or passed. A QA status write resets it.';
