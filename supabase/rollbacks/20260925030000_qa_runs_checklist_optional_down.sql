-- Rollback: 20260925030000_qa_runs_checklist_optional
-- Restores the required, RESTRICT checklist link on QA runs.
--
-- Refuses to run while any run has lost its checklist: NOT NULL would fail on
-- those rows anyway, and failing with a sentence beats failing with a
-- constraint name. Those runs belong to deleted workspaces; delete them (or
-- keep this migration) before narrowing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects.qa_verification_runs WHERE checklist_id IS NULL) THEN
    RAISE EXCEPTION
      'QA runs exist whose checklist was deleted; remove them before restoring the required checklist link.';
  END IF;
END $$;

ALTER TABLE projects.qa_verification_runs
  DROP CONSTRAINT IF EXISTS qa_verification_runs_checklist_id_fkey;

ALTER TABLE projects.qa_verification_runs
  ALTER COLUMN checklist_id SET NOT NULL;

ALTER TABLE projects.qa_verification_runs
  ADD CONSTRAINT qa_verification_runs_checklist_id_fkey
  FOREIGN KEY (checklist_id) REFERENCES projects.qa_checklists(id) ON DELETE RESTRICT;
