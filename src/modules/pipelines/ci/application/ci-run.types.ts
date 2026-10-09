import type { StageId, StageStatus } from './resolve-stage-status';
import type { CiResults, FriendlyMessage } from './translate-results';

/*
 * The shapes a stored CI run is returned in. They live apart from
 * CiReportsService so the report builder (ci-run-report.ts) can describe a run
 * without importing the service that builds it.
 */

export interface StageReport {
  stage: StageId;
  status: StageStatus;
  /**
   * The GitHub run this stage executed in.
   *
   * Sent so a client can ask for the stage's failure output without parsing it
   * back out of `githubRunUrl`, which is a display string and free to change.
   */
  runId: number;
  friendlyMessages: FriendlyMessage[];
  githubRunUrl: string;
  updatedAt: string;
  rawLogs: string | null;
  /**
   * What each tool in the stage concluded.
   *
   * A stage status answers "did quality pass". It cannot answer "did the
   * licence scan pass", and the client had no way to ask: `results` was stored
   * and never returned, so one bar stood in for seven tools.
   *
   * Empty for a stage reported by a pipeline generated before per-tool
   * reporting existed. Empty means "not known", never "no tools ran".
   */
  checks: StageCheck[];
  /**
   * The figures the stage reported, as stored: test counts and failures,
   * coverage against its threshold, lint, security counts and items, findings
   * and the Sonar gate with its measures.
   *
   * `friendlyMessages` renders these into sentences, which is right for a
   * failure and wrong for a pass: a passing stage's whole value is its
   * numbers ("412 tests, 87% coverage"), and a client cannot rebuild numbers
   * from prose. Absent when the stage stored none (never reported, or an older
   * pipeline) and the per-key shape matches what ingest accepted.
   */
  results?: StageResults;
}

/** What ingest stores under `results`, minus the per-tool list `checks` carries. */
export type StageResults = Omit<CiResults, 'checks'>;

/** One tool's outcome inside a stage. */
export interface StageCheck {
  name: string;
  conclusion: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RunGroup {
  runId: number;
  repoFullName: string;
  branch: string;
  commitSha: string;
  startedAt: string;
  overallStatus: 'success' | 'failure' | 'running' | 'cancelled' | 'partial';
  stages: StageReport[];
}

export interface RunsResponse {
  runs: RunGroup[];
}
