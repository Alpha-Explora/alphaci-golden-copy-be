import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import { QA_BRANCH } from '#kernel/config/pipeline-branches';
import type { QaChecklistVerificationType } from '../application/qa-checklists/qa-checklists.contracts';
import type { QaRequirementKind } from '../application/qa-checklists/qa-requirements.contracts';
import type {
  QaProjectVerificationStatus,
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
  /** false when a run for this (Project, set of heads) already existed and was returned instead. */
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

const EMPTY_COUNTS = (): QaVerificationStatusCounts => ({
  pending: 0,
  passed: 0,
  failed: 0,
  blocked: 0,
  returned_to_dev: 0,
});

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
   * (delivery_project_id, heads_fingerprint) partial unique index, then
   * SELECT, so two concurrent requests for the same set of heads converge on
   * one run. The coverage rows and the item snapshot are written in the same
   * transaction, and only on the branch that actually created the run.
   */
  async createRun(
    input: CreateProjectRunInput,
  ): Promise<CreateProjectRunResult> {
    return this.databaseService.withTransaction(async (client) => {
      const insertResult = await client.query<QaProjectRunRow>(
        `
          INSERT INTO projects.qa_verification_runs (
            scope, delivery_project_id, heads_fingerprint, project_id, checklist_id,
            checklist_version, checklist_name, branch, commit_sha, commit_source,
            created_by, created_by_login
          )
          VALUES ('project', $1, $2, NULL, NULL, 0, $3, $4, NULL, 'branch_head', $5, $6)
          ON CONFLICT (delivery_project_id, heads_fingerprint) WHERE scope = 'project'
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
          input.deliveryProjectId,
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
          WHERE scope = 'project' AND delivery_project_id = $1 AND heads_fingerprint = $2;
        `,
        [input.deliveryProjectId, input.headsFingerprint],
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

  /** source_item_id -> run item id, from the Project's newest earlier run. */
  private async priorItemsBySource(
    client: Pick<PoolClient, 'query'>,
    deliveryProjectId: string,
    excludeRunId: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const priorRun = await client.query<{ id: string }>(
      `
        SELECT id FROM projects.qa_verification_runs
        WHERE scope = 'project' AND delivery_project_id = $1 AND id <> $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
      `,
      [deliveryProjectId, excludeRunId],
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
    deliveryProjectId: string,
    headsFingerprint: string,
  ): Promise<QaProjectRunRow | null> {
    const result = await this.databaseService.query<QaProjectRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE scope = 'project' AND delivery_project_id = $1 AND heads_fingerprint = $2;
      `,
      [deliveryProjectId, headsFingerprint],
    );
    return result.rows[0] ?? null;
  }

  /** Newest Project run first; `cursor` is the previous page's last (createdAt, id). */
  async listProjectRuns(
    deliveryProjectId: string,
    options: {
      limit: number;
      cursor: { createdAt: string; id: string } | null;
    },
  ): Promise<QaProjectRunRow[]> {
    const values: unknown[] = [deliveryProjectId];
    let cursorSql = '';
    if (options.cursor) {
      values.push(options.cursor.createdAt, options.cursor.id);
      cursorSql = `AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
    }
    values.push(options.limit);
    const result = await this.databaseService.query<QaProjectRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE scope = 'project' AND delivery_project_id = $1 ${cursorSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length};
      `,
      values,
    );
    return result.rows;
  }

  /** The newest Project run, optionally only an open one. */
  async findNewestProjectRun(
    deliveryProjectId: string,
    options: { openOnly: boolean },
  ): Promise<QaProjectRunRow | null> {
    const result = await this.databaseService.query<QaProjectRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE scope = 'project' AND delivery_project_id = $1
          AND ($2::boolean = FALSE OR status = 'open')
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
      `,
      [deliveryProjectId, options.openOnly],
    );
    return result.rows[0] ?? null;
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
   * The Project run whose ACTIVE sign-off has the greatest signed_at. A
   * reopened (superseded) sign-off no longer counts, and an open run never has
   * an active one - exactly "the latest signed-off Project run".
   */
  async findLatestSignedOff(
    deliveryProjectId: string,
  ): Promise<QaProjectLatestSignoff | null> {
    const signoffResult = await this.databaseService.query<QaRunSignoffRow>(
      `
        SELECT s.*
        FROM projects.qa_run_signoffs s
        JOIN projects.qa_verification_runs r ON r.id = s.run_id
        WHERE r.scope = 'project'
          AND r.delivery_project_id = $1
          AND r.status = 'signed_off'
          AND s.superseded_at IS NULL
        ORDER BY s.signed_at DESC, s.id DESC
        LIMIT 1;
      `,
      [deliveryProjectId],
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
      const status = (
        row.status === 'in_progress' ? 'pending' : row.status
      ) as QaProjectVerificationStatus;
      counts[status] += Number(row.n);
      map.set(row.requirement_id, counts);
    }
    return map;
  }

  /**
   * Run items of the Project's OPEN runs that were sent back to development
   * for this requirement item: what a Progress -> done flips back to pending.
   */
  async findReturnedOpenRunItems(
    deliveryProjectId: string,
    sourceItemId: string,
  ): Promise<QaRunItemRow[]> {
    const result = await this.databaseService.query<QaRunItemRow>(
      `
        SELECT i.*
        FROM projects.qa_run_items i
        JOIN projects.qa_verification_runs r ON r.id = i.run_id
        WHERE r.scope = 'project'
          AND r.status = 'open'
          AND r.delivery_project_id = $1
          AND i.source_item_id = $2
          AND i.status = 'returned_to_dev';
      `,
      [deliveryProjectId, sourceItemId],
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
