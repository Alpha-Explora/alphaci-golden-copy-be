import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import { CiRunReportsRepository } from '../infrastructure/ci-run-reports.repository';
import { translateResults } from './translate-results';
import {
  resolveOverallStatus,
  resolveStages,
  STAGE_ORDER,
  type StageId,
  type StageStatus,
} from './resolve-stage-status';
import type { CiReportBodyDto } from '../api/dto/ci-report-body.dto';
import type { CiRunStatus } from '../infrastructure/ci-run-reports.repository';
import type { FriendlyMessage } from './translate-results';

// ─── Response shapes ──────────────────────────────────────────────────────────

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
}

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

@Injectable()
export class CiReportsService {
  private readonly logger = new Logger(CiReportsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ciRunReportsRepository: CiRunReportsRepository,
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
        results: {
          ...(body.results.tests !== undefined && {
            tests: body.results.tests,
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
        },
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
   * ownership is verified. When omitted the user's runs across all their repos
   * are returned (no ownership check needed — the query filters by user_id).
   */
  async getRuns(
    userId: string,
    repoFullName?: string,
    limit?: number,
    offset?: number,
  ): Promise<RunsResponse> {
    if (repoFullName) {
      await this.assertOwnership(userId, repoFullName);
      const rows = await this.ciRunReportsRepository.findRecentByRepo(
        repoFullName,
        limit,
        offset,
      );
      return { runs: this.groupIntoRuns(rows) };
    }

    const rows = await this.ciRunReportsRepository.findRecentByUser(
      userId,
      limit,
      offset,
    );
    return { runs: this.groupIntoRuns(rows) };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

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

  private async assertOwnership(
    userId: string,
    repoFullName: string,
  ): Promise<void> {
    const result = await this.databaseService.query<OwnershipRow>(
      `
        SELECT user_id
        FROM projects.provisioned_projects
        WHERE repo_full_name = $1
          AND user_id = $2
        LIMIT 1;
      `,
      [repoFullName, userId],
    );

    if (!result.rows[0]) {
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
    const stored = row.friendly_messages;
    if (row.status !== 'failure' || (stored && stored.length > 0)) {
      return stored ?? [];
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
  ): RunGroup[] {
    // access/quality/package are three independent GitHub Actions workflows
    // chained via workflow_run, so each gets its own distinct run_id — they
    // never share one. The value every stage of a single pipeline execution
    // does share is the commit SHA (threaded through via HEAD_SHA_EXPR in the
    // generated workflows), so that — not run_id — is the correlation key.
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
      const groupKey = `${row.repo_full_name}::${row.commit_sha}`;

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
        group.stageRunIds.set(row.stage, runId);
        if (row.created_at < group.startedAt) {
          group.startedAt = row.created_at;
        }
        group.stages.set(row.stage, {
          stage: row.stage,
          status: row.status,
          runId,
          friendlyMessages: this.explainedMessages(row),
          githubRunUrl: `https://github.com/${row.repo_full_name}/actions/runs/${String(runId)}`,
          updatedAt: row.updated_at,
          rawLogs: row.raw_logs,
          checks: readChecks(row.results),
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
      );

      const stages: StageReport[] = ALL_STAGES.map((stageName) => {
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
