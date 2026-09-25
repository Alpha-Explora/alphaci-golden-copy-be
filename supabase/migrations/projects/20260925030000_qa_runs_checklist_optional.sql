-- Keep QA run history when its checklist is deleted.
--
-- Deleting a workspace now removes its QA checklists (WorkspaceDataCleanupPort,
-- implemented by QaChecklistsService). qa_verification_runs.checklist_id was
-- ON DELETE RESTRICT, which would block that delete for any checklist that has
-- ever been run. A run does not need its checklist row to stay complete: it
-- already snapshots checklist_name / checklist_version, every item lives in
-- qa_run_items, and a signed-off run keeps its frozen report_json. So the link
-- becomes optional and is cleared on delete instead.
--
-- The FK was declared inline without a name, so it is found by column rather
-- than by a guessed generated name, then re-added under an explicit one.
-- Idempotent: exits early when the FK is already ON DELETE SET NULL.
DO $$
DECLARE
  v_attnum        smallint;
  v_fk_name       text;
  v_fk_on_delete  "char";
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'projects.qa_verification_runs'::regclass
    AND attname = 'checklist_id'
    AND NOT attisdropped;

  IF v_attnum IS NULL THEN
    RAISE EXCEPTION 'projects.qa_verification_runs.checklist_id not found; aborting';
  END IF;

  SELECT conname, confdeltype INTO v_fk_name, v_fk_on_delete
  FROM pg_constraint
  WHERE conrelid = 'projects.qa_verification_runs'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[v_attnum];

  IF v_fk_on_delete = 'n' THEN
    RETURN;
  END IF;

  IF v_fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE projects.qa_verification_runs DROP CONSTRAINT %I', v_fk_name);
  END IF;

  ALTER TABLE projects.qa_verification_runs
    ALTER COLUMN checklist_id DROP NOT NULL;

  ALTER TABLE projects.qa_verification_runs
    ADD CONSTRAINT qa_verification_runs_checklist_id_fkey
    FOREIGN KEY (checklist_id) REFERENCES projects.qa_checklists(id) ON DELETE SET NULL;
END $$;
