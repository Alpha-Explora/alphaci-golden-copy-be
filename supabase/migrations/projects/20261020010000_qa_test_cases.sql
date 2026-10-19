-- QA test cases: categories of test cases under a User story, and each
-- Project run's copy of them with QA's result.
--
-- Additive only: three new tables, nothing existing is altered, so the code
-- deployed before this change keeps working against it.
--
-- Model (ADR-0014, amendment 10):
--   qa_checklist_items (a User story)
--     -> qa_test_case_categories (QA's grouping: "Happy path", "Validation")
--          -> qa_test_cases (what QA checks, with the expected result)
--   qa_run_items (the story inside one Project run)
--     -> qa_run_test_cases (the run's copy of each test case and its result)
--
-- The definitions persist across runs, like Progress; the results are a
-- verdict about specific heads, like Verification, so they live on the run.
-- An OPEN run's copies follow the definitions (the backend re-syncs them on
-- every definition write); a signed-off run's copies are frozen.
--
-- Cross-context note: created_by and verified_by are plain UUIDs with no
-- foreign key, the same pattern as the other QA tables.
--
-- Cold-replay note: every constraint is inline in its CREATE TABLE, so a fresh
-- replay and a re-run both succeed.

CREATE TABLE IF NOT EXISTS projects.qa_test_case_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES projects.qa_checklist_items(id) ON DELETE CASCADE,
  "position" INTEGER NOT NULL CONSTRAINT qa_test_case_categories_position_chk CHECK ("position" >= 0),
  name TEXT NOT NULL
    CONSTRAINT qa_test_case_categories_name_length_chk CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_test_case_categories_item_name
  ON projects.qa_test_case_categories (item_id, lower(name));

COMMENT ON TABLE projects.qa_test_case_categories
  IS 'A group of QA test cases under one User story (qa_checklist_items row). Written by QA and admins.';

CREATE TABLE IF NOT EXISTS projects.qa_test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES projects.qa_test_case_categories(id) ON DELETE CASCADE,
  "position" INTEGER NOT NULL CONSTRAINT qa_test_cases_position_chk CHECK ("position" >= 0),
  title TEXT NOT NULL
    CONSTRAINT qa_test_cases_title_length_chk CHECK (char_length(title) BETWEEN 1 AND 300),
  expected_result TEXT NULL
    CONSTRAINT qa_test_cases_expected_result_length_chk CHECK (char_length(expected_result) <= 2000),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_qa_test_cases_category
  ON projects.qa_test_cases (category_id, "position");

COMMENT ON TABLE projects.qa_test_cases
  IS 'One QA test case inside a test case category of a User story.';

CREATE TABLE IF NOT EXISTS projects.qa_run_test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES projects.qa_verification_runs(id) ON DELETE CASCADE,
  run_item_id UUID NOT NULL REFERENCES projects.qa_run_items(id) ON DELETE CASCADE,
  -- SET NULL so deleting a definition never rewrites a signed-off run; an
  -- open run drops the orphaned copy on its next sync.
  source_test_case_id UUID NULL REFERENCES projects.qa_test_cases(id) ON DELETE SET NULL,
  source_category_id UUID NULL REFERENCES projects.qa_test_case_categories(id) ON DELETE SET NULL,
  -- Snapshot columns: what the definition said when last synced.
  category_name TEXT NOT NULL
    CONSTRAINT qa_run_test_cases_category_name_length_chk CHECK (char_length(category_name) BETWEEN 1 AND 120),
  category_position INTEGER NOT NULL
    CONSTRAINT qa_run_test_cases_category_position_chk CHECK (category_position >= 0),
  "position" INTEGER NOT NULL CONSTRAINT qa_run_test_cases_position_chk CHECK ("position" >= 0),
  title TEXT NOT NULL
    CONSTRAINT qa_run_test_cases_title_length_chk CHECK (char_length(title) BETWEEN 1 AND 300),
  expected_result TEXT NULL
    CONSTRAINT qa_run_test_cases_expected_result_length_chk CHECK (char_length(expected_result) <= 2000),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT qa_run_test_cases_status_chk
    CHECK (status IN ('pending', 'passed', 'failed', 'blocked', 'not_applicable')),
  notes TEXT NULL CONSTRAINT qa_run_test_cases_notes_length_chk CHECK (char_length(notes) <= 4000),
  verified_by UUID NULL,
  verified_by_login TEXT NULL,
  verified_at TIMESTAMPTZ NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A verifier is recorded exactly when the test case has a result.
  CONSTRAINT qa_run_test_cases_verifier_presence_chk
    CHECK ((status = 'pending') = (verified_by IS NULL)),
  -- The sync's upsert key: one copy of a definition per story per run.
  CONSTRAINT uq_qa_run_test_cases_item_source UNIQUE (run_item_id, source_test_case_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_run_test_cases_run
  ON projects.qa_run_test_cases (run_id, run_item_id);

COMMENT ON TABLE projects.qa_run_test_cases
  IS 'One test case as tested in one Project run. Follows the definition while the run is open; frozen once it is signed off.';

ALTER TABLE projects.qa_test_case_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.qa_test_cases           ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.qa_run_test_cases       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON projects.qa_test_case_categories FROM anon, authenticated;
REVOKE ALL ON projects.qa_test_cases           FROM anon, authenticated;
REVOKE ALL ON projects.qa_run_test_cases       FROM anon, authenticated;
