-- Give qa_run_signoffs.superseded_by a login, alongside signed_by_login (Slice 4).
--
-- Every other actor column on this table already carries its own *_login
-- sibling (signed_by/signed_by_login) so the API layer never has to resolve a
-- user id to a display name itself -- see the cross-context note in
-- 20260925020000_qa_runs.sql on why these are plain UUIDs with no FK.
-- superseded_by was the one exception: reopenRun() only ever wrote the actor's
-- id. The QA report export's sign-off history (Slice 4) needs a
-- human-readable actor for each superseded sign-off, so this adds the missing
-- column; QaRunsRepository.reopenRun is updated in the same change to
-- populate it going forward.
--
-- Rows superseded before this migration keep a NULL login -- the export reads
-- that as { id, login: null } instead of guessing one.
ALTER TABLE projects.qa_run_signoffs
  ADD COLUMN IF NOT EXISTS superseded_by_login TEXT NULL;
