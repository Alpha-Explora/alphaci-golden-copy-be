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

export interface CiStageTestResults {
  total: number;
  passed: number;
  failed: number;
  /** Capped at the first 20 by the reporting workflow; see failuresTruncated. */
  failures: CiStageTestFailure[];
  /** True when `failed` exceeds `failures.length` — the list is a prefix, not the whole set. */
  failuresTruncated: boolean;
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
