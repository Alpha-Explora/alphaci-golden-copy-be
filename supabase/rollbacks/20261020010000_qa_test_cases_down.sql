-- Rollback for 20261020010000_qa_test_cases.sql.
--
-- Dropping these tables deletes QA's test cases and every recorded result,
-- so this fails closed while any row exists: export the QA reports first,
-- delete the rows by hand, then re-run. Nothing is deleted implicitly.

BEGIN;

DO $$
BEGIN
  IF to_regclass('projects.qa_test_case_categories') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM projects.qa_test_case_categories)
     OR EXISTS (SELECT 1 FROM projects.qa_run_test_cases) THEN
    RAISE EXCEPTION
      'QA test cases or test case results exist; dropping the tables would lose them. Remove them first.';
  END IF;
END
$$;

DROP TABLE IF EXISTS projects.qa_run_test_cases;
DROP TABLE IF EXISTS projects.qa_test_cases;
DROP TABLE IF EXISTS projects.qa_test_case_categories;

COMMIT;
