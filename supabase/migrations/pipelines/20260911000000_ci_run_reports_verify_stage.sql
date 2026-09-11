-- Migration: 20260911000000_ci_run_reports_verify_stage
-- Description: Widens workflow.ci_run_reports.stage to admit 'verify', the stage
--              that runs after a deployment and exercises the running service.
-- Notes:
--   - The three existing stages all read source: 'access' checks entitlement,
--     'quality' analyses the code, 'package' builds and deploys the artifact.
--     None of them can answer whether the deployed api actually behaves, which
--     is what the API tests, contract fuzzing and load checks are for. Those
--     have to run after 'package', so they need a stage of their own rather
--     than a fourth meaning stapled onto an existing one.
--   - Widening only. No existing row changes, and every value accepted before
--     is still accepted, so a deployment carrying this migration can be rolled
--     back to the previous application build without orphaning data. The
--     reverse is not true once a 'verify' row exists, which is why the
--     migration ships ahead of the generator that writes one.
--   - DROP ... IF EXISTS then ADD rather than one statement, because Postgres
--     has no ALTER CONSTRAINT for a CHECK. The drop makes the pair re-runnable:
--     a second run removes the constraint it is about to recreate.
--   - The constraint name is stated explicitly. Postgres generated
--     `ci_run_reports_stage_check` for the inline CHECK in the original
--     migration, and naming it here keeps a future migration from having to
--     guess what the generator produced.
-- Prereq: 20260614000100_ci_run_reports must already be applied.

ALTER TABLE workflow.ci_run_reports
  DROP CONSTRAINT IF EXISTS ci_run_reports_stage_check;

ALTER TABLE workflow.ci_run_reports
  ADD CONSTRAINT ci_run_reports_stage_check
  CHECK (stage IN ('access', 'quality', 'package', 'verify'));
