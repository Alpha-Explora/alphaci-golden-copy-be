import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  PROJECT_VISIBILITY_LOOKUP,
  type ProjectVisibilityLookup,
} from '#kernel/ports/project-visibility.port';
import { CiRunReportsRepository } from '../infrastructure/ci-run-reports.repository';
import { buildCiRunReport, type CiRunReport } from './ci-run-report';
import {
  cleanMessages,
  reclassifyStoredFailure,
  skippedMessage,
  stripAnsiDeep,
  translateResults,
} from './translate-results';
import type {
  RunGroup,
  RunsResponse,
  StageCheck,
  StageReport,
  StageResults,
} from './ci-run.types';
import {
  resolveOverallStatus,
  resolveStages,
  STAGE_ORDER,
  type StageId,
} from './resolve-stage-status';
import type { CiReportBodyDto } from '../api/dto/ci-report-body.dto';
import type { CiRunStatus } from '../infrastructure/ci-run-reports.repository';
import type { FriendlyMessage } from './translate-results';

// Response shapes live in ci-run.types.ts; re-exported so importers of this
// module keep working.
export type {
  RunGroup,
  RunsResponse,
  StageCheck,
  StageReport,
  StageResults,
} from './ci-run.types';

// ─── Ownership lookup row ─────────────────────────────────────────────────────

interface OwnershipRow {
  user_id: string;
}

const ALL_STAGES = STAGE_ORDER;

/**
 * Pull the per-tool list back out of the stored `results` blob.
 *
 * `results` is jsonb and typed `Record<string, unknown>`, so nothing the
 * database hands back is trusted here: a row written by an older pipeline has
 * no `checks` key at all, and one written by a future pipeline could carry a
 * shape this build does not know. Anything that is not a well-formed entry is
 * dropped rather than rendered as `undefined` in the UI.
 */
function readChecks(results: Record<string, unknown>): StageCheck[] {
  const raw = results['checks'];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry): StageCheck[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }

    const { name, conclusion, startedAt, completedAt } = entry as Record<
      string,
      unknown
    >;

    if (typeof name !== 'string' || typeof conclusion !== 'string') {
      return [];
    }

    return [
      {
        name,
        conclusion,
        ...(typeof startedAt === 'string' && { startedAt }),
        ...(typeof completedAt === 'string' && { completedAt }),
      },
    ];
  });
}

/** The structured result keys returned to clients, in storage order. */
const RESULT_KEYS = [
  'tests',
  'coverage',
  'lint',
  'security',
  'findings',
  'sonar',
] as const;

/** Defensive ceiling on any list inside a stored result. Ingest already caps. */
const RESULT_LIST_CAP = 50;

function capLists(value: unknown): unknown {
  // Escape codes from a test runner's colouring: stripped on read so stored
  // rows written before ingest cleaned them render clean too.
  if (typeof value === 'string') {
    return stripAnsiDeep(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, RESULT_LIST_CAP).map(capLists);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, capLists(entry)]),
    );
  }
  return value;
}

/**
 * The structured results back out of the stored blob, or undefined for none.
 *
 * Same distrust as `readChecks`: the column is jsonb, so a key is returned
 * only when it is an object, and the lists inside are capped again in case a
 * row predates the limits ingest enforces today.
 */
function readResults(results: unknown): StageResults | undefined {
  if (typeof results !== 'object' || results === null) {
    return undefined;
  }

  const stored = results as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of RESULT_KEYS) {
    const value = stored[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      picked[key] = capLists(value);
    }
  }

  return Object.keys(picked).length > 0 ? (picked as StageResults) : undefined;
}

/**
 * Why a stage was left out on purpose, when it reported that.
 *
 * Stored as a successful report carrying `results.skipped.reason` (the status
 * column cannot hold a new value without a migration), so the read path turns
 * it back into what it is: a stage that did not run, with the reason.
 */
function readSkipReason(results: unknown): string | undefined {
  if (typeof results !== 'object' || results === null) {
    return undefined;
  }
  const skipped = (results as Record<string, unknown>)['skipped'];
  if (typeof skipped !== 'object' || skipped === null) {
    return undefined;
  }
  const reason = (skipped as Record<string, unknown>)['reason'];
  return typeof reason === 'string' && reason.trim() !== ''
    ? stripAnsiDeep(reason)
    : undefined;
}

/**
 * A pull request's merge ref (`7/merge`).
 *
 * GitHub runs the access workflow on it for a pull_request event, so its
 * report is filed under that ref. The chained stages file theirs under the
 * pull request's HEAD branch, so a merge-ref group can only ever hold the
 * access stage and every later one resolved to stalled: eleven red runs for
 * pull requests that were fine. It is not a pipeline execution of a branch.
 */
const MERGE_REF = /^\d+\/merge$/;

function optionalResults(results: unknown): { results?: StageResults } {
  const read = readResults(results);
  return read ? { results: read } : {};
}

@Injectable()
export class CiReportsService {
  private readonly logger = new Logger(CiReportsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ciRunReportsRepository: CiRunReportsRepository,
    @Inject(PROJECT_VISIBILITY_LOOKUP)
    private readonly projectVisibility: ProjectVisibilityLookup,
  ) {}

  /**
   * Ingest a CI run report from the generated workflow via ALPHACI_TOKEN auth.
   * Resolves user ownership from the provisioned project, translates results
   * into friendly messages, then upserts the row.
   */
  async ingestReport(body: CiReportBodyDto): Promise<{ received: true }> {
    try {
      const userId = await this.resolveUserIdByRepo(body.repoFullName);
      const status = this.conclusionToStatus(body.conclusion);
      const friendlyMessages = translateResults(
        body.stage,
        body.conclusion,
        body.results,
        body.rawLogs,
        body.annotations ?? [],
      );

      await this.ciRunReportsRepository.upsert({
        userId,
        repoFullName: body.repoFullName,
        branch: body.branch,
        commitSha: body.commitSha,
        runId: body.runId,
        stage: body.stage,
        status,
        results: stripAnsiDeep({
          ...(body.results.tests !== undefined && {
            tests: body.results.tests,
          }),
          ...(body.results.skipped !== undefined && {
            skipped: body.results.skipped,
          }),
          ...(body.results.coverage !== undefined && {
            coverage: body.results.coverage,
          }),
          ...(body.results.lint !== undefined && { lint: body.results.lint }),
          ...(body.results.security !== undefined && {
            security: body.results.security,
          }),
          ...(body.results.findings !== undefined && {
            findings: body.results.findings,
          }),
          ...(body.results.sonar !== undefined && {
            sonar: body.results.sonar,
          }),
          /*
           * The per-tool list is stored inside `results` rather than in a
           * column of its own, because `results` is already jsonb and this
           * needs no schema change to carry it. A stage that reports no checks
           * — an older pipeline — leaves the key out rather than storing an
           * empty array, so "this pipeline predates per-tool reporting" stays
           * distinguishable from "this stage ran no tools".
           */
          ...(body.checks !== undefined &&
            body.checks.length > 0 && { checks: body.checks }),
        }),
        friendlyMessages,
        ...(body.rawLogs !== undefined && { rawLogs: body.rawLogs }),
      });
    } catch (err) {
      // Re-throw HTTP exceptions (NotFoundException) so NestJS handles them
      if (
        err instanceof NotFoundException ||
        err instanceof ForbiddenException
      ) {
        throw err;
      }

      this.logger.error(
        `Failed to ingest CI report for ${body.repoFullName}/${String(body.runId)}/${body.stage}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }

    return { received: true };
  }

  /**
   * Return grouped runs for the authenticated user.
   *
   * When repoFullName is provided the results are scoped to that repository and
   * visibility is verified. When omitted, runs of every project the caller can SEE
   * are returned (project visibility, not ingest-time ownership), optionally
   * narrowed to one workspaceId (team).
   */
  async getRuns(
    userId: string,
    repoFullName?: string,
    limit?: number,
    offset?: number,
    workspaceId?: string,
  ): Promise<RunsResponse> {
    if (repoFullName) {
      await this.assertOwnership(userId, repoFullName);
      const rows = await this.ciRunReportsRepository.findRecentByRepo(
        repoFullName,
        limit,
        offset,
      );
      return {
        runs: this.groupIntoRuns(rows, await this.environmentRepos(rows)),
      };
    }

    const repos = await this.projectVisibility.listVisibleRepoNames(
      userId,
      workspaceId,
    );
    const rows = await this.ciRunReportsRepository.findRecentByRepos(
      repos,
      limit,
      offset,
    );
    return {
      runs: this.groupIntoRuns(rows, await this.environmentRepos(rows)),
    };
  }

  /**
   * The report of one pipeline execution, for export. Same visibility rule as
   * the run list: the caller must be able to see the repository's project.
   * A 404 when nothing was reported for that repository, branch and commit.
   */
  async getRunReport(
    userId: string,
    repoFullName: string,
    branch: string,
    commitSha: string,
  ): Promise<CiRunReport> {
    await this.assertOwnership(userId, repoFullName);
    const rows = await this.ciRunReportsRepository.findByRepoBranchSha(
      repoFullName,
      branch,
      commitSha,
    );
    const run = this.groupIntoRuns(rows)[0];
    if (!run) {
      throw new NotFoundException(
        `No CI results were reported for ${repoFullName} on ${branch} at ${commitSha.slice(0, 7)}.`,
      );
    }
    return buildCiRunReport({ generatedAt: new Date().toISOString(), run });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Repositories whose project defines its own environments. Their generated
   * pipelines end at the package stage: the release is deployed per
   * environment and has no verify workflow, so waiting for a verify report
   * would mark every one of their runs as failed.
   */
  private async environmentRepos(
    rows: ReadonlyArray<{ repo_full_name: string }>,
  ): Promise<ReadonlySet<string>> {
    const repos = [...new Set(rows.map((row) => row.repo_full_name))];
    if (repos.length === 0) return new Set();
    const result = await this.databaseService.query<{
      repo_full_name: string;
    }>(
      `
        SELECT DISTINCT project.repo_full_name
        FROM projects.provisioned_projects AS project
        JOIN projects.project_environments AS environment
          ON environment.project_id = project.id
        WHERE project.repo_full_name = ANY($1::text[]);
      `,
      [repos],
    );
    return new Set(result.rows.map((row) => row.repo_full_name));
  }

  private async resolveUserIdByRepo(repoFullName: string): Promise<string> {
    const result = await this.databaseService.query<OwnershipRow>(
      `
        SELECT user_id
        FROM projects.provisioned_projects
        WHERE repo_full_name = $1
          AND status = 'provisioned'
        LIMIT 1;
      `,
      [repoFullName],
    );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException(
        `No provisioned project found for repository '${repoFullName}'.`,
      );
    }

    return row.user_id;
  }

  /**
   * Was owner-only (pp.user_id = caller), which answered 403 for a team
   * member or QA tester who can see the project everywhere else in the
   * product. Now the same role-aware visibility rule as the rest of the
   * project (global admin, owner, active workspace member, or an assigned
   * hierarchy repository) — see PROJECT_VISIBILITY_LOOKUP's doc comment for
   * why this crosses the Pipelines/Projects boundary through a port instead
   * of a repository query here.
   */
  private async assertOwnership(
    userId: string,
    repoFullName: string,
  ): Promise<void> {
    const visible = await this.projectVisibility.isRepoVisibleToUser(
      repoFullName,
      userId,
    );

    if (!visible) {
      throw new ForbiddenException(
        `You do not have access to reports for repository '${repoFullName}'.`,
      );
    }
  }

  private conclusionToStatus(
    conclusion: 'success' | 'failure' | 'cancelled',
  ): CiRunStatus {
    switch (conclusion) {
      case 'success':
        return 'success';
      case 'failure':
        return 'failure';
      case 'cancelled':
        return 'cancelled';
    }
  }

  /**
   * The stored messages, or a recomputed explanation when a failure has none.
   *
   * Messages are written at ingest, so a row is stuck with whatever the
   * translator said at the time. Two things left failures with nothing:
   * `translateResults` only explained a failure when `results` was empty — so a
   * stage that reported passing coverage and failed elsewhere was silent — and
   * on private repositories the workflow captured no failed job name at all,
   * because the reporting job lacked `actions: read`.
   *
   * Both are fixed going forward, but history would stay mute, and only a new
   * run would repair it. Recomputing here from the columns we already store
   * repairs those rows on read, without a migration, and keeps the product
   * honest if a future ingest ever writes an empty set again.
   *
   * Deliberately narrow: only when a FAILURE carries no messages. A successful
   * stage with nothing to say is correct, not broken.
   */
  private explainedMessages(row: {
    stage: StageId;
    status: CiRunStatus;
    friendly_messages: FriendlyMessage[];
    results: unknown;
    raw_logs: string | null;
  }): FriendlyMessage[] {
    const skipReason =
      row.status === 'success' ? readSkipReason(row.results) : undefined;
    if (skipReason !== undefined) {
      return cleanMessages([skippedMessage(skipReason)]);
    }

    const stored = row.friendly_messages ?? [];
    if (row.status !== 'failure') {
      return cleanMessages(stored);
    }

    if (stored.length > 0) {
      // Escape codes and `:null` locations are cleaned, and a verify failure
      // filed under "Tests failed" for a deployment that never came up gets its
      // real copy back. None of it needs the original annotations, which are
      // not stored, so history benefits without a backfill.
      return cleanMessages(
        reclassifyStoredFailure(row.stage, stored, row.raw_logs),
      );
    }

    return translateResults(
      row.stage,
      'failure',
      (row.results ?? {}) as Parameters<typeof translateResults>[2],
      row.raw_logs ?? undefined,
    );
  }

  private groupIntoRuns(
    rows: Awaited<ReturnType<CiRunReportsRepository['findRecentByRepo']>>,
    environmentRepos: ReadonlySet<string> = new Set(),
  ): RunGroup[] {
    // access/quality/package are three independent GitHub Actions workflows
    // chained via workflow_run, so each gets its own distinct run_id — they
    // never share one. The value every stage of a single pipeline execution
    // does share is the commit SHA (threaded through via HEAD_SHA_EXPR in the
    // generated workflows), so that — not run_id — is the correlation key.
    //
    // BRANCH IS PART OF THAT KEY.
    //
    // A promoted commit keeps its SHA. The same commit is therefore built on
    // dev, again on uat, and again on main, and each of those is a separate
    // pipeline execution with its own results. Keyed on the SHA alone they
    // collapsed into one group, the first branch seen won, and the other two
    // runs disappeared from the product entirely — the stage-level guard below
    // then discarded their reports as duplicates of a stage already filled.
    //
    // Measured on a real repository: commit d2d3dbe carried six reports across
    // dev, uat and main and rendered as a single run on one branch.
    const groupOrder: string[] = [];
    const groupMap = new Map<
      string,
      {
        repoFullName: string;
        branch: string;
        commitSha: string;
        startedAt: string;
        stages: Map<string, StageReport>;
        stageRunIds: Map<string, number>;
      }
    >();

    // Rows arrive ordered run_id DESC, so for a given stage the first row
    // seen is the most recent attempt — skip older re-runs of the same stage
    // instead of letting them overwrite the freshest status.
    for (const row of rows) {
      // pg returns bigint as string; parse to number (GitHub run IDs are safe integers)
      const runId = Number(row.run_id);
      if (MERGE_REF.test(row.branch)) {
        continue;
      }
      const groupKey = `${row.repo_full_name}::${row.branch}::${row.commit_sha}`;

      if (!groupMap.has(groupKey)) {
        groupOrder.push(groupKey);
        groupMap.set(groupKey, {
          repoFullName: row.repo_full_name,
          branch: row.branch,
          commitSha: row.commit_sha,
          startedAt: row.created_at,
          stages: new Map(),
          stageRunIds: new Map(),
        });
      }

      const group = groupMap.get(groupKey);
      if (group && !group.stages.has(row.stage)) {
        const skipped =
          row.status === 'success' && readSkipReason(row.results) !== undefined;
        group.stageRunIds.set(row.stage, runId);
        if (row.created_at < group.startedAt) {
          group.startedAt = row.created_at;
        }
        group.stages.set(row.stage, {
          stage: row.stage,
          status: skipped ? 'not_applicable' : row.status,
          runId,
          friendlyMessages: this.explainedMessages(row),
          githubRunUrl: `https://github.com/${row.repo_full_name}/actions/runs/${String(runId)}`,
          updatedAt: row.updated_at,
          rawLogs: row.raw_logs,
          checks: readChecks(row.results),
          ...optionalResults(row.results),
        });
      }
    }

    return groupOrder.map((groupKey) => {
      const group = groupMap.get(groupKey);
      if (!group) {
        // Should not happen — every key in groupOrder came from groupMap
        return {
          runId: 0,
          repoFullName: '',
          branch: '',
          commitSha: '',
          startedAt: '',
          overallStatus: 'partial' as const,
          stages: [],
        };
      }

      // Represent the pipeline by its furthest-progressed stage's run_id —
      // that's the run most relevant for the user to open on GitHub.
      const primaryRunId =
        group.stageRunIds.get('package') ??
        group.stageRunIds.get('quality') ??
        group.stageRunIds.get('access') ??
        0;

      // A stage with no report is not simply "pending". It may be blocked by an
      // earlier failure, or stalled — the stage before it succeeded and nothing
      // ever arrived, which is what a workflow rejected at startup looks like
      // from here, because it runs no jobs and so cannot report.
      const resolved = resolveStages(
        Object.fromEntries(
          [...group.stages.entries()].map(([stageName, report]) => [
            stageName,
            { status: report.status, updatedAt: report.updatedAt },
          ]),
        ),
        new Date(),
        // Which stages the pipeline runs depends on the branch: verify has
        // nothing to test on dev, so its absence there is not a stall.
        group.branch,
      );

      // Environment pipelines have no verify stage to wait for.
      const expectedStages = environmentRepos.has(group.repoFullName)
        ? ALL_STAGES.filter((stageName) => stageName !== 'verify')
        : ALL_STAGES;

      const stages: StageReport[] = expectedStages.map((stageName) => {
        const report = group.stages.get(stageName);
        if (report) {
          return report;
        }

        const inferred = resolved[stageName];
        return {
          stage: stageName,
          status: inferred.status,
          // A stage that never reported has no run of its own; the pipeline's
          // representative run is the closest true answer.
          runId: primaryRunId,
          friendlyMessages: inferred.friendlyMessages,
          githubRunUrl: `https://github.com/${group.repoFullName}/actions/runs/${String(primaryRunId)}`,
          updatedAt: '',
          rawLogs: null,
          // A stage that never reported ran no tools we can name.
          checks: [],
        };
      });

      return {
        runId: primaryRunId,
        repoFullName: group.repoFullName,
        branch: group.branch,
        commitSha: group.commitSha,
        startedAt: group.startedAt,
        overallStatus: resolveOverallStatus(stages),
        stages,
      };
    });
  }
}
