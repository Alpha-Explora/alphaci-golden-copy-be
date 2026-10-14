/**
 * Read-only bridge from Pipelines' CI reports to whatever else needs a
 * stage's latest result by (repo, branch, commit) — first consumer is the
 * QA verification-runs slice's automated-result badge.
 *
 * Pipelines owns `workflow.ci_run_reports` and binds this port; Projects
 * only depends on the narrow shape below. A promoted commit exists on
 * several branches with a separate report row set per branch (see
 * ci-reports.service.ts's groupIntoRuns for the same fact applied to
 * /ci/runs), so branch is part of the key here too — never look this up by
 * commit sha alone.
 */

export type CiStageId = 'quality' | 'verify';

export type CiStageStatus = 'success' | 'failure' | 'running' | 'cancelled';

export interface CiStageTestFailure {
  name: string;
  message: string;
}

export type CiTestCaseStatus = 'passed' | 'failed' | 'flaky' | 'skipped';

/** One `test.step` of a test, as Playwright recorded it (top level only). */
export interface CiTestCaseStep {
  title: string;
  durationMs?: number;
  failed?: boolean;
}

/** An annotation the test wrote, other than its description (e.g. a result note). */
export interface CiTestCaseNote {
  type: string;
  text: string;
}

/**
 * One test as the browser suite ran it: what it is, what it checks, what it
 * did and how it ended. The reporting workflow lists failures first and caps
 * the list, so `cases.length < total` means it is a prefix.
 */
export interface CiTestCase {
  /** " > "-joined: spec file, describe blocks, test title. */
  title: string;
  file?: string;
  line?: number;
  /** The Playwright project, normally the browser. */
  project?: string;
  status: CiTestCaseStatus;
  durationMs?: number;
  retries?: number;
  /** The test's own `description` annotation: what it checks, in words. */
  description?: string;
  notes?: CiTestCaseNote[];
  steps?: CiTestCaseStep[];
  error?: { message: string; location?: string };
}

export interface CiStageTestResults {
  total: number;
  passed: number;
  failed: number;
  /** Capped at the first 20 by the reporting workflow; see failuresTruncated. */
  failures: CiStageTestFailure[];
  /** True when `failed` exceeds `failures.length` — the list is a prefix, not the whole set. */
  failuresTruncated: boolean;
  /**
   * Full titles (" > "-joined, spec file first) of the tests that PASSED, when
   * the reporting pipeline says so. ABSENT means an older pipeline that did
   * not report them - consumers must then infer, and say they did. An empty
   * array is a real answer ("ran, nothing passed"). Capped by the pipeline at
   * 500 names, so `passes.length < passed` means the list is a prefix.
   */
  passes?: string[];
  /** Every test with its detail, when the pipeline reports it (see CiTestCase). */
  cases?: CiTestCase[];
}

export interface CiStageResult {
  stage: CiStageId;
  status: CiStageStatus;
  /** The GitHub Actions run this stage's newest report came from. */
  runId: number;
  runUrl: string;
  /** When this report row was last written (ci_run_reports.updated_at). */
  reportedAt: string;
  /** Null when the report carries no `results.tests` — not every stage runs tests. */
  tests: CiStageTestResults | null;
}

export interface CiStageResultsLookupInput {
  repoFullName: string;
  branch: string;
  commitSha: string;
  stages: CiStageId[];
}

export interface CiStageResultsLookup {
  /**
   * The newest report (highest run_id) per requested stage, for the exact
   * (repoFullName, branch, commitSha) triple. A stage with no matching row
   * is simply absent from the result — callers treat "absent" as "no report
   * yet", never as a status to guess at.
   */
  latestStageReports(
    input: CiStageResultsLookupInput,
  ): Promise<CiStageResult[]>;
}

export const CI_STAGE_RESULTS_LOOKUP = Symbol('CiStageResultsLookup');
