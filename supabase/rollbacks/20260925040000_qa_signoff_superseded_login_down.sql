-- Rollback: 20260925040000_qa_signoff_superseded_login
ALTER TABLE projects.qa_run_signoffs
  DROP COLUMN IF EXISTS superseded_by_login;
