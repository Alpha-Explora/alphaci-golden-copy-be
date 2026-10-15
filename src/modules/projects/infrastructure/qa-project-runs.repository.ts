import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import { QA_BRANCH } from '#kernel/config/pipeline-branches';
import type { QaChecklistVerificationType } from '../application/qa-checklists/qa-checklists.contracts';
import type { QaRequirementKind } from '../application/qa-checklists/qa-requirements.contracts';
import type {
  QaDefectSeverity,
  QaProjectVerificationStatus,
  QaRunItemStatus,
  QaRunStatus,
  QaVerdict,
  QaVerificationStatusCounts,
} from '../application/qa-runs/qa-runs.contracts';
import type {
  QaProjectRunRow,
  QaRunItemRow,
  QaRunRepositoryRow,
  QaRunSignoffRow,
} from './qa-runs.repository';

/** One requirement item, frozen into a run item at run start. */
export interface ProjectRunSnapshotItem {
  sourceItemId: string;
  requirementId: string;
  requirementName: string;
  requirementKind: QaRequirementKind;
  /** Global across the run: requirements in order (functional first), items by position. */
  position: number;
  title: string;
  description: string | null;
  verificationType: QaChecklistVerificationType;
  testIdentifier: string | null;
  acceptanceCriteria: string | null;
}

export interface CreateProjectRunInput {
  deliveryProjectId: string;
  /** The Project's active Iteration: part of the idempotency key. */
  iterationId: string;
  /** Stored as the run's label (checklist_name). */
  projectName: string;
  /** sha256 hex of the sorted "<provisioned_project_id>:<head_sha>" lines. */
  headsFingerprint: string;
  repositories: Array<{
    projectId: string;
    repoFullName: string;
    headSha: string;
  }>;
  createdBy: string;
  createdByLogin: string;
  items: ProjectRunSnapshotItem[];
}

export interface CreateProjectRunResult {
  /** false when a run for this (Iteration, set of heads) already existed and was returned instead. */
  created: boolean;
  run: QaProjectRunRow;
  items: QaRunItemRow[];
  repositories: QaRunRepositoryRow[];
}

export interface QaProjectLatestSignoff {
  run: QaProjectRunRow;
  signoff: QaRunSignoffRow;
  repositories: QaRunRepositoryRow[];
}

/**
 * A Project's newest run with its current (non-superseded) sign-off, the
 * handful of columns the team overview shows. Timestamps are ISO strings at
 * microsecond precision, formatted in SQL so they round-trip as a `since`.
 */
export interface QaProjectRunHeadline {
  deliveryProjectId: string;
  runId: string;
  status: QaRunStatus;
  createdAt: string;
  /** Null while the run is open (an open run has no active sign-off). */
  verdict: QaVerdict | null;
  signedAt: string | null;
  signedByLogin: string | null;
}

/** One run item reduced to what the overview counts: where it came from and how it stands. */
export interface QaRunItemFact {
  runId: string;
  sourceItemId: string | null;
  requirementId: string | null;
  status: QaRunItemStatus;
  defectSeverity: QaDefectSeverity | null;
}

const EMPTY_COUNTS = (): QaVerificationStatusCounts => ({
  pending: 0,
  passed: 0,
  failed: 0,
  blocked: 0,
  returned_to_dev: 0,
});

/**
 * Verification counts per requirement from run item facts (null key = source
 * requirement deleted). 'in_progress' is not a Project-run status; any legacy
 * value folds into pending, the same as verificationCountsByRequirement.
 */
export function tallyVerificationByRequirement(
  items: ReadonlyArray<Pick<QaRunItemFact, 'requirementId' | 'status'>>,
): Map<string | null, QaVerificationStatusCounts> {
  const map = new Map<string | null, QaVerificationStatusCounts>();
  for (const item of items) {
    const counts = map.get(item.requirementId) ?? EMPTY_COUNTS();
    counts[foldVerificationStatus(item.status)] += 1;
    map.set(item.requirementId, counts);
  }
  return map;
}

function foldVerificationStatus(status: string): QaProjectVerificationStatus {
  return (
    status === 'in_progress' ? 'pending' : status
  ) as QaProjectVerificationStatus;
}

/**
 * Persistence for Project-scope runs. The shared run machinery - item writes,
 * sign-off, reopen, retest - stays in QaRunsRepository and works on run_id;
 * this class owns only what is specific to a run that covers a whole Project:
 * the idempotent create keyed on the captured heads, the coverage rows, and
 * the Project-level lookups.
 */
@Injectable()
export class QaProjectRunsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Idempotent create: INSERT ... ON CONFLICT DO NOTHING on the
   * (iteration_id, heads_fingerprint) partial unique index, then SELECT, so
   * two concurrent requests for the same set of heads converge on one run. The
   * same heads in a NEW Iteration are a new key, hence a new run. The coverage rows and the item snapshot are written in the same
   * transaction, and only on the branch that actually created the run.
   */
  async createRun(
    input: CreateProjectRunInput,
  ): Promise<CreateProjectRunResult> {
    return this.databaseService.withTransaction(async (client) => {
      const insertResult = await client.query<QaProjectRunRow>(
        `
          INSERT INTO projects.qa_verification_runs (
            scope, delivery_project_id, iteration_id, heads_fingerprint, project_id,
            checklist_id, checklist_version, checklist_name, branch, commit_sha,
            commit_source, created_by, created_by_login
          )
          VALUES ('project', $1, $7, $2, NULL, NULL, 0, $3, $4, NULL, 'branch_head', $5, $6)
          ON CONFLICT (iteration_id, heads_fingerprint) WHERE scope = 'project'
          DO NOTHING
          RETURNING *;
        `,
        [
          input.deliveryProjectId,
          input.headsFingerprint,
          input.projectName,
          QA_BRANCH,
          input.createdBy,
          input.createdByLogin,
          input.iterationId,
        ],
      );

      const inserted = insertResult.rows[0];
      if (inserted) {
        const repositories = await this.insertCoverage(
          client,
          inserted.id,
          input.repositories,
        );
        const priorBySource = await this.priorItemsBySource(
          client,
          input.iterationId,
          inserted.id,
        );
        const items = await this.insertRunItems(
          client,
          inserted.id,
          input.items,
          priorBySource,
        );
        return { created: true, run: inserted, items, repositories };
      }

      const existingResult = await client.query<QaProjectRunRow>(
        `
          SELECT * FROM projects.qa_verification_runs
          WHERE scope = 'project' AND iteration_id = $1 AND heads_fingerprint = $2;
        `,
        [input.iterationId, input.headsFingerprint],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        // Unreachable in practice: the INSERT conflicted on this exact unique
        // key, so a row satisfying it must exist. Fails loudly rather than
        // returning an unsound result if that invariant is ever wrong.
        throw new Error(
          'qa_verification_runs INSERT conflicted but no matching Project run was found',
        );
      }
      const [items, repositories] = await Promise.all([
        client.query<QaRunItemRow>(
          `SELECT * FROM projects.qa_run_items WHERE run_id = $1 ORDER BY "position";`,
          [existing.id],
        ),
        client.query<QaRunRepositoryRow>(
          `SELECT * FROM projects.qa_run_repositories WHERE run_id = $1 ORDER BY repo_full_name;`,
          [existing.id],
        ),
      ]);
      return {
        created: false,
        run: existing,
        items: items.rows,
        repositories: repositories.rows,
      };
    });
  }

  private async insertCoverage(
    client: Pick<PoolClient, 'query'>,
    runId: string,
    repositories: CreateProjectRunInput['repositories'],
  ): Promise<QaRunRepositoryRow[]> {
    if (repositories.length === 0) {
      return [];
    }
    const values: unknown[] = [runId];
    const rowsSql = repositories
      .map((repository) => {
        const base = values.length;
        values.push(
          repository.projectId,
          repository.repoFullName,
          repository.headSha,
        );
        return `($1, $${base + 1}, $${base + 2}, $${base + 3})`;
      })
      .join(',\n');
    const result = await client.query<QaRunRepositoryRow>(
      `
        INSERT INTO projects.qa_run_repositories (run_id, project_id, repo_full_name, head_sha)
        VALUES ${rowsSql}
        RETURNING *;
      `,
      values,
    );
    return result.rows.sort((a, b) =>
      a.repo_full_name.localeCompare(b.repo_full_name),
    );
  }

  /** source_item_id -> run item id, from the Iteration's newest earlier run. */
  private async priorItemsBySource(
    client: Pick<PoolClient, 'query'>,
    iterationId: string,
    excludeRunId: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const priorRun = await client.query<{ id: string }>(
      `
        SELECT id FROM projects.qa_verification_runs
        WHERE scope = 'project' AND iteration_id = $1 AND id <> $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
      `,
      [iterationId, excludeRunId],
    );
    const priorRunId = priorRun.rows[0]?.id;
    if (!priorRunId) {
      return map;
    }
    const priorItems = await client.query<{
      id: string;
      source_item_id: string | null;
    }>(
      `
        SELECT id, source_item_id FROM projects.qa_run_items
        WHERE run_id = $1 AND source_item_id IS NOT NULL;
      `,
      [priorRunId],
    );
    for (const row of priorItems.rows) {
      if (row.source_item_id) {
        map.set(row.source_item_id, row.id);
      }
    }
    return map;
  }

  private async insertRunItems(
    client: Pick<PoolClient, 'query'>,
    runId: string,
    items: ProjectRunSnapshotItem[],
    priorBySource: Map<string, string>,
  ): Promise<QaRunItemRow[]> {
    if (items.length === 0) {
      return [];
    }
    const values: unknown[] = [runId];
    const rowsSql = items
      .map((item) => {
        const base = values.length;
        values.push(
          item.sourceItemId,
          priorBySource.get(item.sourceItemId) ?? null,
          item.position,
          item.title,
          item.description,
          item.verificationType,
          item.testIdentifier,
          item.requirementId,
          item.requirementName,
          item.requirementKind,
          item.acceptanceCriteria,
        );
        const params = Array.from(
          { length: 11 },
          (_, offset) => `$${base + offset + 1}`,
        );
        return `($1, ${params.slice(0, 5).join(', ')}, 'all', ${params.slice(5).join(', ')})`;
      })
      .join(',\n');

    const result = await client.query<QaRunItemRow>(
      `
        INSERT INTO projects.qa_run_items (
          run_id, source_item_id, prior_run_item_id, "position", title, description,
          target_persona, verification_type, test_identifier, requirement_id,
          requirement_name, requirement_kind, acceptance_criteria
        )
        VALUES ${rowsSql}
        RETURNING *;
      `,
      values,
    );
    return result.rows.sort((a, b) => a.position - b.position);
  }

  async findProjectRun(
    deliveryProjectId: string,
    runId: string,
  ): Promise<QaProjectRunRow | null> {
    const result = await this.databaseService.query<QaProjectRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE id = $1 AND scope = 'project' AND delivery_project_id = $2;
      `,
      [runId, deliveryProjectId],
    );
    return result.rows[0] ?? null;
  }

  async findRunByFingerprint(
    iterationId: string,
    headsFingerprint: string,
  ): Promise<QaProjectRunRow | null> {
    const result = await this.databaseService.query<QaProjectRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE scope = 'project' AND iteration_id = $1 AND heads_fingerprint = $2;
      `,
      [iterationId, headsFingerprint],
    );
    return result.rows[0] ?? null;
  }

  /** One Iteration's Project runs, newest first; `cursor` is the previous page's last (createdAt, id). */
  async listProjectRuns(
    iterationId: string,
    options: {
      limit: number;
      cursor: { createdAt: string; id: string } | null;
    },
  ): Promise<QaProjectRunRow[]> {
    const values: unknown[] = [iterationId];
    let cursorSql = '';
    if (options.cursor) {
      values.push(options.cursor.createdAt, options.cursor.id);
      cursorSql = `AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
    }
    values.push(options.limit);
    const result = await this.databaseService.query<QaProjectRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE scope = 'project' AND iteration_id = $1 ${cursorSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length};
      `,
      values,
    );
    return result.rows;
  }

  /** The Iteration's newest Project run, optionally only an open one. */
  async findNewestProjectRun(
    iterationId: string,
    options: { openOnly: boolean },
  ): Promise<QaProjectRunRow | null> {
    const result = await this.databaseService.query<QaProjectRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE scope = 'project' AND iteration_id = $1
          AND ($2::boolean = FALSE OR status = 'open')
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
      `,
      [iterationId, options.openOnly],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The newest run of each Project plus its active sign-off, for all
   * `iterationIds` (each Project's current Iteration) in ONE query (the
   * overview must not ask per Project). Same order as findNewestProjectRun
   * (created_at, id, newest first); a Project with no run is absent. The active sign-off is unique per run
   * (uq_qa_run_signoffs_run_active), so the LEFT JOIN never fans out.
   */
  async findLatestRunHeadlines(
    iterationIds: readonly string[],
  ): Promise<Map<string, QaProjectRunHeadline>> {
    const map = new Map<string, QaProjectRunHeadline>();
    if (iterationIds.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<{
      delivery_project_id: string;
      run_id: string;
      status: QaRunStatus;
      created_at: string;
      verdict: QaVerdict | null;
      signed_at: string | null;
      signed_by_login: string | null;
    }>(
      `
        SELECT DISTINCT ON (r.delivery_project_id)
          r.delivery_project_id,
          r.id AS run_id,
          r.status,
          to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          s.verdict,
          to_char(s.signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS signed_at,
          s.signed_by_login
        FROM projects.qa_verification_runs r
        LEFT JOIN projects.qa_run_signoffs s
          ON s.run_id = r.id AND s.superseded_at IS NULL
        WHERE r.scope = 'project'
          AND r.iteration_id = ANY($1::uuid[])
        ORDER BY r.delivery_project_id, r.created_at DESC, r.id DESC;
      `,
      [iterationIds],
    );
    for (const row of result.rows) {
      map.set(row.delivery_project_id, {
        deliveryProjectId: row.delivery_project_id,
        runId: row.run_id,
        status: row.status,
        createdAt: row.created_at,
        verdict: row.verdict,
        signedAt: row.signed_at,
        signedByLogin: row.signed_by_login,
      });
    }
    return map;
  }

  /**
   * Every item of the given runs reduced to its facts, grouped by run, in ONE
   * query. A run with no items is absent.
   */
  async listItemFactsByRunIds(
    runIds: readonly string[],
  ): Promise<Map<string, QaRunItemFact[]>> {
    const map = new Map<string, QaRunItemFact[]>();
    if (runIds.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<{
      run_id: string;
      source_item_id: string | null;
      requirement_id: string | null;
      status: QaRunItemStatus;
      defect_severity: QaDefectSeverity | null;
    }>(
      `
        SELECT run_id, source_item_id, requirement_id, status, defect_severity
        FROM projects.qa_run_items
        WHERE run_id = ANY($1::uuid[]);
      `,
      [runIds],
    );
    for (const row of result.rows) {
      const list = map.get(row.run_id) ?? [];
      list.push({
        runId: row.run_id,
        sourceItemId: row.source_item_id,
        requirementId: row.requirement_id,
        status: row.status,
        defectSeverity: row.defect_severity,
      });
      map.set(row.run_id, list);
    }
    return map;
  }

  async listCoverageByRunIds(
    runIds: string[],
  ): Promise<Map<string, QaRunRepositoryRow[]>> {
    const map = new Map<string, QaRunRepositoryRow[]>();
    if (runIds.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<QaRunRepositoryRow>(
      `
        SELECT * FROM projects.qa_run_repositories
        WHERE run_id = ANY($1::uuid[])
        ORDER BY run_id, repo_full_name;
      `,
      [runIds],
    );
    for (const row of result.rows) {
      const list = map.get(row.run_id) ?? [];
      list.push(row);
      map.set(row.run_id, list);
    }
    return map;
  }

  /**
   * The Iteration's Project run whose ACTIVE sign-off has the greatest
   * signed_at. A reopened (superseded) sign-off no longer counts, and an open
   * run never has an active one - exactly "the latest signed-off Project run".
   */
  async findLatestSignedOff(
    iterationId: string,
  ): Promise<QaProjectLatestSignoff | null> {
    const signoffResult = await this.databaseService.query<QaRunSignoffRow>(
      `
        SELECT s.*
        FROM projects.qa_run_signoffs s
        JOIN projects.qa_verification_runs r ON r.id = s.run_id
        WHERE r.scope = 'project'
          AND r.iteration_id = $1
          AND r.status = 'signed_off'
          AND s.superseded_at IS NULL
        ORDER BY s.signed_at DESC, s.id DESC
        LIMIT 1;
      `,
      [iterationId],
    );
    const signoff = signoffResult.rows[0];
    if (!signoff) {
      return null;
    }
    const runResult = await this.databaseService.query<QaProjectRunRow>(
      `SELECT * FROM projects.qa_verification_runs WHERE id = $1;`,
      [signoff.run_id],
    );
    const run = runResult.rows[0];
    if (!run) {
      return null;
    }
    const coverage = await this.listCoverageByRunIds([run.id]);
    return { run, signoff, repositories: coverage.get(run.id) ?? [] };
  }

  /**
   * Adds every item of the Iteration's active requirements that an OPEN
   * Project run of it does not hold yet, as a pending row after the run's last
   * position (same snapshot columns as createRun). A run keeps the items that
   * existed when it started; without this, a story written later could never
   * be verified on unchanged heads (one run per Iteration and heads), and the
   * gate, which needs every item passed, would stay closed. Each open run row
   * is locked first, as every other run write does. Returns the rows added.
   */
  async appendMissingItemsToOpenRuns(iterationId: string): Promise<number> {
    return this.databaseService.withTransaction(async (client) => {
      const open = await client.query<{ id: string }>(
        `
          SELECT id FROM projects.qa_verification_runs
          WHERE scope = 'project' AND iteration_id = $1 AND status = 'open'
          ORDER BY id
          FOR UPDATE;
        `,
        [iterationId],
      );
      let added = 0;
      for (const run of open.rows) {
        const result = await client.query(
          `
            INSERT INTO projects.qa_run_items (
              run_id, source_item_id, "position", title, description,
              target_persona, verification_type, test_identifier, requirement_id,
              requirement_name, requirement_kind, acceptance_criteria
            )
            SELECT $1, i.id,
                   base.last_position + (row_number() OVER (
                     ORDER BY (c.kind = 'functional') DESC, c.created_at, c.id,
                              i."position", i.id
                   ))::int,
                   i.title, i.description, i.target_persona, i.verification_type,
                   i.test_identifier, c.id, c.name, c.kind, i.acceptance_criteria
            FROM projects.qa_checklist_items i
            JOIN projects.qa_checklists c ON c.id = i.checklist_id
            CROSS JOIN (
              SELECT COALESCE(MAX("position"), -1) AS last_position
              FROM projects.qa_run_items WHERE run_id = $1
            ) base
            WHERE c.iteration_id = $2
              AND c.archived_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM projects.qa_run_items ri
                WHERE ri.run_id = $1 AND ri.source_item_id = i.id
              );
          `,
          [run.id, iterationId],
        );
        added += result.rowCount ?? 0;
      }
      return added;
    });
  }

  /**
   * How many items of the Iteration's active requirements have no PASSED row
   * in `runId`: items added after the run started, and any the run left
   * unpassed. Zero means the run verified every item the Iteration holds now.
   */
  async countIterationItemsNotPassed(
    iterationId: string,
    runId: string,
  ): Promise<number> {
    const result = await this.databaseService.query<{ n: number }>(
      `
        SELECT COUNT(*)::int AS n
        FROM projects.qa_checklist_items i
        JOIN projects.qa_checklists c ON c.id = i.checklist_id
        WHERE c.iteration_id = $1
          AND c.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM projects.qa_run_items ri
            WHERE ri.run_id = $2
              AND ri.source_item_id = i.id
              AND ri.status = 'passed'
          );
      `,
      [iterationId, runId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Verification status counts per requirement for one run (null key = source requirement deleted). */
  async verificationCountsByRequirement(
    runId: string,
  ): Promise<Map<string | null, QaVerificationStatusCounts>> {
    const result = await this.databaseService.query<{
      requirement_id: string | null;
      status: string;
      n: string;
    }>(
      `
        SELECT requirement_id, status, COUNT(*) AS n
        FROM projects.qa_run_items
        WHERE run_id = $1
        GROUP BY requirement_id, status;
      `,
      [runId],
    );
    const map = new Map<string | null, QaVerificationStatusCounts>();
    for (const row of result.rows) {
      const counts = map.get(row.requirement_id) ?? EMPTY_COUNTS();
      // 'in_progress' is not a Project-run status; fold any legacy value into pending.
      counts[foldVerificationStatus(row.status)] += Number(row.n);
      map.set(row.requirement_id, counts);
    }
    return map;
  }

  /**
   * Run items of the Iteration's OPEN runs that were sent back to development
   * for this requirement item: what a Progress -> done flips back to pending.
   */
  async findReturnedOpenRunItems(
    iterationId: string,
    sourceItemId: string,
  ): Promise<QaRunItemRow[]> {
    const result = await this.databaseService.query<QaRunItemRow>(
      `
        SELECT i.*
        FROM projects.qa_run_items i
        JOIN projects.qa_verification_runs r ON r.id = i.run_id
        WHERE r.scope = 'project'
          AND r.status = 'open'
          AND r.iteration_id = $1
          AND i.source_item_id = $2
          AND i.status = 'returned_to_dev';
      `,
      [iterationId, sourceItemId],
    );
    return result.rows;
  }

  /** A run item with its Project run, by the run item's id (for the request-retest alias). */
  async findRunItemWithProjectRun(
    itemId: string,
  ): Promise<{ item: QaRunItemRow; run: QaProjectRunRow } | null> {
    const itemResult = await this.databaseService.query<QaRunItemRow>(
      `SELECT * FROM projects.qa_run_items WHERE id = $1;`,
      [itemId],
    );
    const item = itemResult.rows[0];
    if (!item) {
      return null;
    }
    const runResult = await this.databaseService.query<QaProjectRunRow>(
      `SELECT * FROM projects.qa_verification_runs WHERE id = $1 AND scope = 'project';`,
      [item.run_id],
    );
    const run = runResult.rows[0];
    return run ? { item, run } : null;
  }
}
