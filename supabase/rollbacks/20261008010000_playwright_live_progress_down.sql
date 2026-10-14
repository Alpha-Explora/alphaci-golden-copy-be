-- Rollback: 20261008010000_playwright_live_progress
-- Drops the live Playwright progress tables. The data is transient (the latest
-- 10 runs per branch, only meaningful while a run is in flight), so nothing of
-- lasting value is lost.
BEGIN;
DROP TABLE IF EXISTS workflow.playwright_live_tests;
DROP TABLE IF EXISTS workflow.playwright_live_runs;
COMMIT;
