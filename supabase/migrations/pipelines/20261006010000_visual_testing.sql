-- Migration: 20261006010000_visual_testing
-- Description: ALPHACI-stored visual-regression baselines and per-run visual
--              results for the generated pipelines' Playwright verify stage.
--              Three tables in the `workflow` schema (the schema that already
--              holds workflow.ci_run_reports, owned by the pipelines context):
--                workflow.visual_baselines      approved reference screenshots
--                workflow.visual_run_snapshots  one row per snapshot per run
--                workflow.visual_run_images     actual / diff PNGs of a run
-- Notes:
--   - Additive and idempotent. Nothing existing is altered, so the previous
--     application build keeps working against this schema, and the migration
--     can be applied BEFORE the backend that uses it deploys.
--   - Images are stored as bytea, not in Supabase Storage: the backend has no
--     storage client today, and v1 volumes are small. Assumptions the sizing
--     rests on (revisit if any is wrong):
--       * a PNG is capped at 3 MB on ingest (typical full-page screenshot is
--         100-500 KB), at most 60 snapshots per run and browser;
--       * the workflow uploads actual/diff images only for CHANGED or NEW
--         snapshots, never for passing ones;
--       * retention keeps the latest 10 runs per (repo, branch), enforced by
--         the application after every write (not by a database job), and a
--         baseline is replaced in place on re-approval, so it is one image
--         per (repo, branch, name) rather than a history.
--     Worst case per branch is therefore 10 runs x 60 x 2 x 3 MB; the realistic
--     case is 10 x (a handful of changed snapshots) x ~300 KB x 2, i.e. a few
--     MB. If a customer genuinely has hundreds of changing snapshots a run,
--     move the png column behind a storage pointer; the repository is the only
--     code that touches it.
--   - Baseline key: (repo, branch, name). `browser` is stored on the baseline
--     but is NOT part of the key. v1 baselines come from one browser
--     (chromium); a name that two browsers produce is, by construction of the
--     workflow's snapshot naming (the project suffix is in the file name),
--     already a different name.
--   - No foreign keys and no joins to other contexts: repo_full_name is the
--     key CI data already uses (workflow.ci_run_reports), and approved_by is a
--     plain uuid plus a denormalised login so the Visual tab can name the
--     approver without reading identity.app_users. (Same "plain uuid, no FK"
--     pattern as projects.qa_checklists.delivery_project_id; the
--     schema-ownership gate therefore needs no new transition entry.) The
--     consequence is that rows are not removed by a database cascade when a
--     project or user is deleted; retention bounds the run data, and
--     baselines of a disconnected repository are small and inert.
--   - Row Level Security is enabled with no policies: the backend connects
--     with the table owner / service role, and no table here is meant to be
--     reachable through PostgREST (same posture as
--     20260617000000_enable_rls_exposed_tables.sql).
-- Prereq: the `workflow` schema must already exist (see earlier migrations).

-- 1. Approved baselines ------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow.visual_baselines (
  id                 uuid         NOT NULL DEFAULT gen_random_uuid(),
  repo_full_name     text         NOT NULL,
  branch             text         NOT NULL,
  name               text         NOT NULL,
  browser            text         NOT NULL DEFAULT 'chromium',
  png                bytea        NOT NULL,
  sha256             text         NOT NULL,
  byte_size          integer      NOT NULL,
  approved_by        uuid         NULL,
  approved_by_login  text         NULL,
  approved_at        timestamptz  NOT NULL DEFAULT now(),
  source_run_id      bigint       NULL,
  source_commit_sha  text         NULL,
  CONSTRAINT visual_baselines_pkey PRIMARY KEY (id),
  CONSTRAINT visual_baselines_unique_name UNIQUE (repo_full_name, branch, name),
  CONSTRAINT visual_baselines_size_chk CHECK (byte_size > 0 AND byte_size <= 3145728),
  CONSTRAINT visual_baselines_name_chk CHECK (char_length(name) BETWEEN 5 AND 120)
);
ALTER TABLE workflow.visual_baselines ENABLE ROW LEVEL SECURITY;
-- Deny-by-default, as 20260617_enable_rls_exposed_tables: the backend's role
-- bypasses RLS; the public PostgREST roles must not reach these rows at all.
REVOKE ALL ON workflow.visual_baselines FROM anon, authenticated;

-- 2. One row per snapshot per run ------------------------------------------
-- Keyed WITHOUT run_attempt: a re-run attempt of the same run replaces the
-- earlier attempt's rows (the application deletes the lower attempt before it
-- inserts), so the Visual tab shows one answer per (run, browser, name).
CREATE TABLE IF NOT EXISTS workflow.visual_run_snapshots (
  id              uuid         NOT NULL DEFAULT gen_random_uuid(),
  repo_full_name  text         NOT NULL,
  branch          text         NOT NULL,
  run_id          bigint       NOT NULL,
  run_attempt     integer      NOT NULL DEFAULT 1,
  commit_sha      text         NOT NULL,
  browser         text         NOT NULL,
  name            text         NOT NULL,
  status          text         NOT NULL,
  reported_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT visual_run_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT visual_run_snapshots_status_chk CHECK (status IN ('passed', 'changed', 'new')),
  CONSTRAINT visual_run_snapshots_unique UNIQUE (repo_full_name, branch, run_id, browser, name)
);
CREATE INDEX IF NOT EXISTS idx_visual_run_snapshots_branch_run
  ON workflow.visual_run_snapshots (repo_full_name, branch, run_id DESC, run_attempt DESC);
ALTER TABLE workflow.visual_run_snapshots ENABLE ROW LEVEL SECURITY;
-- Deny-by-default, as 20260617_enable_rls_exposed_tables: the backend's role
-- bypasses RLS; the public PostgREST roles must not reach these rows at all.
REVOKE ALL ON workflow.visual_run_snapshots FROM anon, authenticated;

-- 3. The images of a run ------------------------------------------------------
-- Separate from the snapshot rows so the summary and the file uploads may
-- arrive in either order (the workflow posts them independently).
CREATE TABLE IF NOT EXISTS workflow.visual_run_images (
  id              uuid         NOT NULL DEFAULT gen_random_uuid(),
  repo_full_name  text         NOT NULL,
  branch          text         NOT NULL,
  run_id          bigint       NOT NULL,
  commit_sha      text         NOT NULL,
  browser         text         NOT NULL,
  name            text         NOT NULL,
  kind            text         NOT NULL,
  png             bytea        NOT NULL,
  sha256          text         NOT NULL,
  byte_size       integer      NOT NULL,
  reported_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT visual_run_images_pkey PRIMARY KEY (id),
  CONSTRAINT visual_run_images_kind_chk CHECK (kind IN ('actual', 'diff')),
  CONSTRAINT visual_run_images_size_chk CHECK (byte_size > 0 AND byte_size <= 3145728),
  CONSTRAINT visual_run_images_unique UNIQUE (repo_full_name, branch, run_id, browser, name, kind)
);
CREATE INDEX IF NOT EXISTS idx_visual_run_images_branch_run
  ON workflow.visual_run_images (repo_full_name, branch, run_id DESC);
ALTER TABLE workflow.visual_run_images ENABLE ROW LEVEL SECURITY;
-- Deny-by-default, as 20260617_enable_rls_exposed_tables: the backend's role
-- bypasses RLS; the public PostgREST roles must not reach these rows at all.
REVOKE ALL ON workflow.visual_run_images FROM anon, authenticated;
