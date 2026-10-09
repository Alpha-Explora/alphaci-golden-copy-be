import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  CiStageId,
  CiStageResult,
  CiStageResultsLookup,
  CiStageResultsLookupInput,
  CiStageTestResults,
  CiTestCase,
  CiTestCaseNote,
  CiTestCaseStatus,
  CiTestCaseStep,
} from '#kernel/ports/ci-stage-results.port';
import type { FriendlyMessage } from '../application/translate-results';
import type { StageId } from '../application/stages';

export type CiRunStatus = 'success' | 'failure' | 'running' | 'cancelled';

export interface UpsertCiRunReportInput {
  userId: string;
  repoFullName: string;
  branch: string;
  commitSha: string;
  runId: number;
  stage: StageId;
  status: CiRunStatus;
  results: Record<string, unknown>;
  friendlyMessages: FriendlyMessage[];
  rawLogs?: string;
}

export interface CiRunReportRow {
  id: string;
  user_id: string;
  repo_full_name: string;
  branch: string;
  commit_sha: string;
  run_id: string; // bigint comes back as string from pg driver
  stage: StageId;
  status: CiRunStatus;
  results: Record<string, unknown>;
  friendly_messages: FriendlyMessage[];
  raw_logs: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `results.tests.passes`, or undefined when absent or malformed. A list with
 * ANY non-string entry is treated as absent rather than filtered: a partly
 * understood list would let the matcher read a missing name as "did not pass".
 */
function readPasses(tests: Record<string, unknown>): string[] | undefined {
  const raw = tests['passes'];
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return raw;
}

const CASE_STATUSES: readonly CiTestCaseStatus[] = [
  'passed',
  'failed',
  'flaky',
  'skipped',
];

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readCaseSteps(value: unknown): CiTestCaseStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps = value.flatMap((entry): CiTestCaseStep[] => {
    const step = (entry ?? {}) as Record<string, unknown>;
    const title = optionalText(step['title']);
    if (!title) {
      return [];
    }
    const durationMs = optionalCount(step['durationMs']);
    return [
      {
        title,
        ...(durationMs !== undefined && { durationMs }),
        ...(step['failed'] === true && { failed: true }),
      },
    ];
  });
  return steps.length > 0 ? steps : undefined;
}

function readCaseNotes(value: unknown): CiTestCaseNote[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const notes = value.flatMap((entry): CiTestCaseNote[] => {
    const note = (entry ?? {}) as Record<string, unknown>;
    const type = optionalText(note['type']);
    const text = optionalText(note['text']);
    return type && text ? [{ type, text }] : [];
  });
  return notes.length > 0 ? notes : undefined;
}

function readCaseError(value: unknown): CiTestCase['error'] {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const error = value as Record<string, unknown>;
  const message = optionalText(error['message']);
  if (!message) {
    return undefined;
  }
  const location = optionalText(error['location']);
  return { message, ...(location !== undefined && { location }) };
}

function readCase(entry: unknown): CiTestCase | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const raw = entry as Record<string, unknown>;
  const title = optionalText(raw['title']);
  const status = CASE_STATUSES.find((known) => known === raw['status']);
  if (!title || !status) {
    return null;
  }
  // exactOptionalPropertyTypes: absent fields are dropped below, never set to undefined.
  const optional: Record<string, unknown> = {
    file: optionalText(raw['file']),
    line: optionalCount(raw['line']),
    project: optionalText(raw['project']),
    durationMs: optionalCount(raw['durationMs']),
    retries: optionalCount(raw['retries']),
    description: optionalText(raw['description']),
    notes: readCaseNotes(raw['notes']),
    steps: readCaseSteps(raw['steps']),
    error: readCaseError(raw['error']),
  };
  const present = Object.fromEntries(
    Object.entries(optional).filter(([, value]) => value !== undefined),
  );
  return { title, status, ...(present as Partial<CiTestCase>) };
}

/**
 * `results.tests.cases`, or undefined when absent. Unlike `passes`, a
 * malformed entry is dropped rather than voiding the list: the cases are
 * shown to people, never used to decide whether an item passed.
 */
function readCases(tests: Record<string, unknown>): CiTestCase[] | undefined {
  const raw = tests['cases'];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw
    .map(readCase)
    .filter((entry): entry is CiTestCase => entry !== null);
}

/**
 * Pull `results.tests` back out of the stored jsonb blob, the same
 * defensive shape as ci-reports.service.ts's readChecks: nothing the
 * database hands back is trusted, since `results` predates per-tool/test
 * reporting and an older row simply has no `tests` key.
 */
function readTestResults(
  results: Record<string, unknown>,
): CiStageTestResults | null {
  const raw = results['tests'];
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { total, passed, failed, failures } = raw as Record<string, unknown>;
  if (
    typeof total !== 'number' ||
    typeof passed !== 'number' ||
    typeof failed !== 'number'
  ) {
    return null;
  }

  const failureList = Array.isArray(failures)
    ? failures.flatMap((entry): CiStageTestResults['failures'] => {
        if (typeof entry !== 'object' || entry === null) {
          return [];
        }
        const { name, message } = entry as Record<string, unknown>;
        return typeof name === 'string'
          ? [{ name, message: typeof message === 'string' ? message : '' }]
          : [];
      })
    : [];

  const passes = readPasses(raw as Record<string, unknown>);
  const cases = readCases(raw as Record<string, unknown>);

  return {
    total,
    passed,
    failed,
    failures: failureList,
    failuresTruncated: failed > failureList.length,
    ...(passes !== undefined && { passes }),
    ...(cases !== undefined && { cases }),
  };
}

@Injectable()
export class CiRunReportsRepository implements CiStageResultsLookup {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * The newest report (highest run_id) per requested stage, for the exact
   * (repoFullName, branch, commitSha) triple — backs CI_STAGE_RESULTS_LOOKUP
   * (see ci-stage-results.port.ts). `DISTINCT ON (stage) ... ORDER BY
   * stage, run_id DESC` picks exactly one, newest, row per stage; a stage
   * with no matching row is simply absent from the result.
   */
  async latestStageReports(
    input: CiStageResultsLookupInput,
  ): Promise<CiStageResult[]> {
    if (input.stages.length === 0) {
      return [];
    }

    const result = await this.databaseService.query<
      Pick<
        CiRunReportRow,
        'stage' | 'status' | 'results' | 'updated_at' | 'repo_full_name'
      > & { run_id: string }
    >(
      `
        SELECT DISTINCT ON (stage)
          stage,
          status,
          run_id::text AS run_id,
          results,
          repo_full_name,
          updated_at
        FROM workflow.ci_run_reports
        WHERE repo_full_name = $1
          AND branch = $2
          AND commit_sha = $3
          AND stage = ANY($4::text[])
        ORDER BY stage, run_id DESC;
      `,
      [input.repoFullName, input.branch, input.commitSha, input.stages],
    );

    return result.rows.map((row) => {
      const runId = Number(row.run_id);
      return {
        stage: row.stage as CiStageId,
        status: row.status,
        runId,
        runUrl: `https://github.com/${row.repo_full_name}/actions/runs/${String(runId)}`,
        reportedAt: row.updated_at,
        tests: readTestResults(row.results),
      };
    });
  }

  /**
   * Upsert a CI run report. The unique key is (repo_full_name, run_id, stage).
   * On conflict the status, results, friendly_messages, raw_logs, and updated_at
   * are refreshed.
   */
  async upsert(data: UpsertCiRunReportInput): Promise<void> {
    // Cap raw logs at 50 000 characters to keep the column bounded.
    const rawLogs =
      data.rawLogs !== undefined && data.rawLogs !== null
        ? data.rawLogs.slice(0, 50_000)
        : null;

    await this.databaseService.query(
      `
        INSERT INTO workflow.ci_run_reports (
          user_id,
          repo_full_name,
          branch,
          commit_sha,
          run_id,
          stage,
          status,
          results,
          friendly_messages,
          raw_logs
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (repo_full_name, run_id, stage)
        DO UPDATE SET
          status            = EXCLUDED.status,
          results           = EXCLUDED.results,
          friendly_messages = EXCLUDED.friendly_messages,
          raw_logs          = EXCLUDED.raw_logs,
          updated_at        = NOW();
      `,
      [
        data.userId,
        data.repoFullName,
        data.branch,
        data.commitSha,
        data.runId,
        data.stage,
        data.status,
        JSON.stringify(data.results),
        JSON.stringify(data.friendlyMessages),
        rawLogs,
      ],
    );
  }

  /**
   * Fetch run-stage rows for a repo, ordered most-recent run first then stages
   * in consistent order within each run.
   *
   * @param repoFullName - The repository to filter by.
   * @param limit - Maximum rows to return (default 150, max 500).
   * @param offset - Rows to skip for pagination (default 0).
   */
  async findRecentByRepo(
    repoFullName: string,
    limit = 150,
    offset = 0,
  ): Promise<CiRunReportRow[]> {
    const result = await this.databaseService.query<CiRunReportRow>(
      `
        SELECT
          id,
          user_id,
          repo_full_name,
          branch,
          commit_sha,
          run_id::text AS run_id,
          stage,
          status,
          results,
          friendly_messages,
          raw_logs,
          created_at,
          updated_at
        FROM workflow.ci_run_reports
        WHERE repo_full_name = $1
        ORDER BY run_id DESC, stage ASC
        LIMIT $2 OFFSET $3;
      `,
      [repoFullName, limit, offset],
    );

    return result.rows;
  }

  /**
   * Every stage report of one pipeline execution: a repository, a branch and a
   * commit. The branch is part of the key because a promoted commit keeps its
   * SHA and is built again on each branch, each with its own results.
   * Most-recent attempt first within a stage, so the first row per stage is
   * the one to show.
   */
  async findByRepoBranchSha(
    repoFullName: string,
    branch: string,
    commitSha: string,
  ): Promise<CiRunReportRow[]> {
    const result = await this.databaseService.query<CiRunReportRow>(
      `
        SELECT
          id,
          user_id,
          repo_full_name,
          branch,
          commit_sha,
          run_id::text AS run_id,
          stage,
          status,
          results,
          friendly_messages,
          raw_logs,
          created_at,
          updated_at
        FROM workflow.ci_run_reports
        WHERE repo_full_name = $1
          AND branch = $2
          AND commit_sha = $3
        ORDER BY run_id DESC, stage ASC;
      `,
      [repoFullName, branch, commitSha],
    );

    return result.rows;
  }

  /**
   * Fetch run-stage rows for a set of repositories, most-recent run first.
   * Used when GET /ci/runs is called without a repoFullName filter. The caller
   * resolves the repo set through PROJECT_VISIBILITY_LOOKUP (projects the user
   * can see, optionally one workspace), so this table is never joined to
   * projects.* here. Matching is case-insensitive; names must be lower-cased.
   *
   * @param repoFullNamesLower - Lower-cased repo_full_name values to include.
   * @param limit - Maximum rows to return (default 150, max 500).
   * @param offset - Rows to skip for pagination (default 0).
   */
  async findRecentByRepos(
    repoFullNamesLower: string[],
    limit = 150,
    offset = 0,
  ): Promise<CiRunReportRow[]> {
    if (repoFullNamesLower.length === 0) return [];
    const result = await this.databaseService.query<CiRunReportRow>(
      `
        SELECT
          id,
          user_id,
          repo_full_name,
          branch,
          commit_sha,
          run_id::text AS run_id,
          stage,
          status,
          results,
          friendly_messages,
          raw_logs,
          created_at,
          updated_at
        FROM workflow.ci_run_reports
        WHERE lower(repo_full_name) = ANY($1::text[])
        ORDER BY run_id DESC, stage ASC
        LIMIT $2 OFFSET $3;
      `,
      [repoFullNamesLower, limit, offset],
    );

    return result.rows;
  }
}
