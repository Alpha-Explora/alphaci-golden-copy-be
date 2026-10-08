-- Migration: 20261008010000_playwright_live_progress
-- Description: Live, test-by-test progress of a Playwright run on uat, posted
--              by the generated verify workflow's reporter while the run is in
--              flight (POST /ci/playwright-progress) and read by the studio's
--              Playwright tab (GET /projects/:id/workspace/playwright-live).
--              Two tables in the `workflow` schema (pipelines context):
--                workflow.playwright_live_runs   one row per (repo, run, attempt)
--                workflow.playwright_live_tests  one row per test per retry
-- Notes:
--   - Additive and idempotent. Nothing existing is altered, so the previous
--     application build keeps working and this can be applied BEFORE the
--     backend that uses it deploys.
--   - Ingestion is idempotent by construction: the reporter may resend a
--     batch, so every write is an upsert on a natural key, never an insert.
--   - Caps are enforced by the application (tests per run), not by triggers.
--     Retention keeps the latest 10 runs per (repo, branch), pruned by the
--     application after every write (same approach as the visual tables).
--   - No foreign keys to other contexts: repo_full_name is the key CI data
--     already uses. The only FK is tests -> runs inside this migration, with
--     ON DELETE CASCADE so pruning a run removes its tests.
--   - RLS is enabled with no policies and anon/authenticated are revoked: the
--     backend connects with the owner/service role; nothing here is meant to
--     be reachable through PostgREST.
-- Prereq: the `workflow` schema must already exist.

-- 1. One row per run attempt ---------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow.playwright_live_runs (
  id              uuid         NOT NULL DEFAULT gen_random_uuid(),
  repo_full_name  text         NOT NULL,
  branch          text         NOT NULL,
  run_id          bigint       NOT NULL,
  run_attempt     integer      NOT NULL DEFAULT 1,
  commit_sha      text         NOT NULL,
  status          text         NOT NULL DEFAULT 'running',
  total           integer      NULL,
  started_at      timestamptz  NULL,
  finished_at     timestamptz  NULL,
  summary         jsonb        NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT playwright_live_runs_pkey PRIMARY KEY (id),
  CONSTRAINT playwright_live_runs_unique UNIQUE (repo_full_name, run_id, run_attempt),
  CONSTRAINT playwright_live_runs_status_chk
    CHECK (status IN ('running', 'passed', 'failed', 'timedout', 'interrupted'))
);
CREATE INDEX IF NOT EXISTS idx_playwright_live_runs_branch_latest
  ON workflow.playwright_live_runs (repo_full_name, branch, run_id DESC, run_attempt DESC);
ALTER TABLE workflow.playwright_live_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workflow.playwright_live_runs FROM anon, authenticated;

-- 2. One row per test per retry ------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow.playwright_live_tests (
  id           uuid         NOT NULL DEFAULT gen_random_uuid(),
  run_pk       uuid         NOT NULL,
  test_key     text         NOT NULL,
  file         text         NOT NULL,
  title        text         NOT NULL,
  project      text         NOT NULL,
  retry        integer      NOT NULL DEFAULT 0,
  status       text         NOT NULL DEFAULT 'running',
  duration_ms  integer      NULL,
  error        text         NULL,
  started_at   timestamptz  NULL,
  finished_at  timestamptz  NULL,
  CONSTRAINT playwright_live_tests_pkey PRIMARY KEY (id),
  CONSTRAINT playwright_live_tests_run_fk
    FOREIGN KEY (run_pk) REFERENCES workflow.playwright_live_runs (id) ON DELETE CASCADE,
  CONSTRAINT playwright_live_tests_unique UNIQUE (run_pk, test_key, project, retry),
  CONSTRAINT playwright_live_tests_status_chk
    CHECK (status IN ('running', 'passed', 'failed', 'skipped', 'timedOut', 'interrupted'))
);
ALTER TABLE workflow.playwright_live_tests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workflow.playwright_live_tests FROM anon, authenticated;
