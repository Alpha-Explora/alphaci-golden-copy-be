-- Rollback: 20261006010000_visual_testing
-- Drops the ALPHACI-stored visual-regression tables.
--
-- Destroys every approved baseline and every retained run result. Baselines
-- are the product of human approval and cannot be regenerated from a run, so
-- take a copy first if any are worth keeping (the next run after a re-apply
-- would report every snapshot as "new"). Run data is disposable: retention
-- keeps only the latest 10 runs per branch anyway.
BEGIN;
DROP TABLE IF EXISTS workflow.visual_run_images;
DROP TABLE IF EXISTS workflow.visual_run_snapshots;
DROP TABLE IF EXISTS workflow.visual_baselines;
COMMIT;
