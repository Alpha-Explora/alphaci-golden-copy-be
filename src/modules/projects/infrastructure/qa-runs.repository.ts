import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import type { QaChecklistItemRow } from './qa-checklists.repository';
import type {
  QaChecklistTargetPersona,
  QaChecklistVerificationType,
} from '../application/qa-checklists/qa-checklists.contracts';
import type {
  QaCommitSource,
  QaDefectSeverity,
  QaRunItemStatus,
  QaRunStatus,
  QaVerdict,
} from '../application/qa-runs/qa-runs.contracts';

interface QaRunRowBase {
  id: string;
  /** Null once its checklist was deleted (workspace deletion); the run keeps its snapshot. Always null on a Project run. */
  checklist_id: string | null;
  checklist_version: number;
  /** A Project run carries the Project's name here. */
  checklist_name: string;
  branch: string;
  commit_source: QaCommitSource;
  status: QaRunStatus;
  created_by: string;
  created_by_login: string;
  created_at: string;
  updated_at: string;
  scope: 'repository' | 'project';
  delivery_project_id: string | null;
  /** The Iteration of a Project run; null on a repository-scope run. */
  iteration_id: string | null;
  heads_fingerprint: string | null;
}

/** A repository-scope run: read-only history since Project requirements. */
export interface QaVerificationRunRow extends QaRunRowBase {
  scope: 'repository';
  project_id: string;
  commit_sha: string;
}

/** A Project run: covers every repository of a Project; the heads live in qa_run_repositories. */
export interface QaProjectRunRow extends QaRunRowBase {
  scope: 'project';
  project_id: null;
  commit_sha: null;
  delivery_project_id: string;
  iteration_id: string;
  heads_fingerprint: string;
}

export type QaAnyRunRow = QaVerificationRunRow | QaProjectRunRow;

export interface QaRunRepositoryRow {
  run_id: string;
  project_id: string;
  repo_full_name: string;
  head_sha: string;
}

export interface QaRunItemRow {
  id: string;
  run_id: string;
  source_item_id: string | null;
  prior_run_item_id: string | null;
  position: number;
  title: string;
  description: string | null;
  target_persona: QaChecklistTargetPersona;
  verification_type: QaChecklistVerificationType;
  test_identifier: string | null;
  status: QaRunItemStatus;
  notes: string | null;
  defect_severity: QaDefectSeverity | null;
  reproduction_steps: string | null;
  fix_requested_at: string | null;
  fix_requested_by: string | null;
  fix_requested_by_login: string | null;
  fix_note: string | null;
  verified_by: string | null;
  verified_by_login: string | null;
  verified_at: string | null;
  row_version: number;
  updated_at: string;
  /** Project runs only: the requirement this item was snapshotted from. */
  requirement_id: string | null;
  requirement_name: string | null;
  requirement_kind: 'functional' | 'system' | null;
  acceptance_criteria: string | null;
}

export interface QaRunSignoffRow {
  id: string;
  run_id: string;
  verdict: QaVerdict;
  summary: string | null;
  conditions: string | null;
  signed_by: string;
  signed_by_login: string;
  signed_at: string;
  report_json: Record<string, unknown>;
  superseded_at: string | null;
  superseded_by: string | null;
  /**
   * Added by 20260925040000_qa_signoff_superseded_login.sql, after
   * superseded_by itself. NULL for two reasons: the row is still active
   * (superseded_by is also null), or it was superseded before that
   * migration shipped -- reopenRun() populates it for every reopen from
   * here on.
   */
  superseded_by_login: string | null;
}

export interface CreateQaRunInput {
  projectId: string;
  checklistId: string;
  checklistVersion: number;
  checklistName: string;
  branch: string;
  commitSha: string;
  commitSource: QaCommitSource;
  createdBy: string;
  createdByLogin: string;
  /** The checklist's current items, snapshotted verbatim into qa_run_items. */
  checklistItems: QaChecklistItemRow[];
}

export interface CreateQaRunResult {
  /** false when an existing run for this (project, checklist, branch, sha) was returned instead. */
  created: boolean;
  run: QaVerificationRunRow;
  items: QaRunItemRow[];
}

/**
 * Fields modeled as `T | undefined` rather than `field?: T`: the caller
 * (QaRunsService) always passes all four keys positionally from a DTO whose
 * own fields may themselves be `undefined` — under this repo's
 * `exactOptionalPropertyTypes: true`, an optional `?` field demands the key
 * be genuinely ABSENT when unset, not present-with-value-undefined.
 */
export interface UpdateQaRunItemPatch {
  status: QaRunItemStatus | undefined;
  /** `undefined` = leave unchanged; `null` = clear. */
  notes: string | null | undefined;
  defectSeverity: QaDefectSeverity | null | undefined;
  reproductionSteps: string | null | undefined;
}

export interface RunActor {
  id: string;
  login: string;
}

/**
 * The two-track rules a Project run adds to a Verification write (design doc
 * 6.3 decision 1 and section 2.4). Passed here, not decided here: the service
 * says which apply, the transaction enforces them under the item locks.
 */
export interface QaProjectItemRules {
  /** 'passed' needs the source requirement item's Progress to be 'done'. */
  requireProgressDoneForPass: boolean;
  /** 'returned_to_dev' puts the source item's Progress back to 'in_progress'. */
  resetProgressOnReturn: boolean;
  /**
   * 'passed' needs every test case of the run item to be passed or not
   * applicable (ADR-0014, amendment 10). Optional: legacy runs have none.
   */
  requireTestCasesResolvedForPass?: boolean;
}

/**
 * 'passed' was refused inside the transaction: the source requirement item's
 * Progress is not 'done', or the source item no longer exists.
 */
export class QaProgressNotDoneError extends Error {
  constructor(itemId: string) {
    super(`QA run item ${itemId} cannot pass: its Progress is not done`);
    this.name = 'QaProgressNotDoneError';
  }
}

/**
 * 'passed' was refused inside the transaction: `open` test cases of the run
 * item are still pending, failed or blocked.
 */
export class QaTestCasesOpenError extends Error {
  constructor(
    itemId: string,
    readonly open: number,
  ) {
    super(
      `QA run item ${itemId} cannot pass: ${open} test case(s) are not resolved`,
    );
    this.name = 'QaTestCasesOpenError';
  }
}

export interface CreateSignoffInput {
  /**
   * Generated by the caller (crypto.randomUUID()) rather than left to the
   * column's DEFAULT: the service needs this exact id to build report_json
   * (which embeds the signoff, including its own id) BEFORE the row exists.
   */
  id: string;
  runId: string;
  verdict: QaVerdict;
  summary: string | null;
  conditions: string | null;
  signedBy: string;
  signedByLogin: string;
  /**
   * Also generated by the caller for the same reason as `id` — and reused
   * as qa_verification_runs.updated_at so the run row and the frozen report
   * agree on the exact instant it was signed off, rather than each taking
   * its own NOW().
   */
  signedAt: string;
  /** The QaRun response as it will read once signed off — frozen for the export slice. */
  reportJson: Record<string, unknown>;
  /**
   * Fingerprint of the items the verdict was validated against and the report
   * was built from: their count and the sum of their row_versions. Every item
   * mutation bumps row_version, so any change in between alters the sum.
   */
  expectedItems: { count: number; rowVersionSum: number };
  /**
   * Project runs only: the ids of the attachments the frozen report lists.
   * Adding or removing a screenshot does not bump an item's row_version, so
   * this is the guard that keeps the report from freezing a stale attachment
   * list. The exact ids, not a count: a delete plus an add keeps the count.
   */
  expectedAttachmentIds?: readonly string[];
}

export interface QaReturnedItemRow {
  item: QaRunItemRow;
  runBranch: string;
  runCommitSha: string;
  runChecklistName: string;
}

/**
 * The run is no longer open. Raised INSIDE the mutating transaction, after
 * taking a lock on the run row, so a signoff that commits between the
 * service's read and this write can never be bypassed.
 */
export class QaRunNotOpenError extends Error {
  constructor(runId: string) {
    super(`QA run ${runId} is not open`);
    this.name = 'QaRunNotOpenError';
  }
}

/**
 * The run's items changed after the signoff was validated and its report
 * built. Signing off anyway would freeze a report (and possibly an APPROVED
 * verdict) that no longer matches the items.
 */
export class QaRunItemsChangedError extends Error {
  constructor(runId: string) {
    super(`QA run ${runId} items changed during signoff`);
    this.name = 'QaRunItemsChangedError';
  }
}

/**
 * Takes a FOR SHARE lock on an open run. Item mutations hold it until commit;
 * createSignoff takes FOR UPDATE on the same row, so the two serialize: a
 * signoff waits for in-flight item writes (then sees their row versions), and
 * an item write waits for an in-flight signoff (then sees status signed_off).
 */
/** The same ids, in any order. */
function sameIds(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  const want = new Set(expected);
  return actual.every((id) => want.has(id));
}

export async function lockOpenRunForItemWrite(
  client: PoolClient,
  runId: string,
): Promise<void> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM projects.qa_verification_runs WHERE id = $1 FOR SHARE;`,
    [runId],
  );
  if (result.rows[0]?.status !== 'open') {
    throw new QaRunNotOpenError(runId);
  }
}

@Injectable()
export class QaRunsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Idempotent create: INSERT ... ON CONFLICT DO NOTHING then SELECT, so two
   * concurrent requests for the same (project, checklist, branch, commit)
   * always converge on one run row. Postgres blocks the second INSERT on the
   * first's uncommitted row until it commits (or rolls back), so the
   * fallback SELECT below is guaranteed to see it once conflicted.
   *
   * Item snapshotting and prior-run linking happen in the same transaction,
   * and only on the branch that actually created a new run — a caller that
   * hit the existing-run path gets that run's own (already snapshotted)
   * items back, untouched.
   */
  async createRun(input: CreateQaRunInput): Promise<CreateQaRunResult> {
    return this.databaseService.withTransaction(async (client) => {
      const insertResult = await client.query<QaVerificationRunRow>(
        `
          INSERT INTO projects.qa_verification_runs (
            project_id, checklist_id, checklist_version, checklist_name,
            branch, commit_sha, commit_source, created_by, created_by_login
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT ON CONSTRAINT uq_qa_verification_runs_project_checklist_branch_commit
          DO NOTHING
          RETURNING *;
        `,
        [
          input.projectId,
          input.checklistId,
          input.checklistVersion,
          input.checklistName,
          input.branch,
          input.commitSha,
          input.commitSource,
          input.createdBy,
          input.createdByLogin,
        ],
      );

      const inserted = insertResult.rows[0];
      if (inserted) {
        const priorRun = await client.query<{ id: string }>(
          `
            SELECT id FROM projects.qa_verification_runs
            WHERE project_id = $1 AND checklist_id = $2 AND branch = $3 AND id <> $4
            ORDER BY created_at DESC
            LIMIT 1;
          `,
          [input.projectId, input.checklistId, input.branch, inserted.id],
        );
        const priorRunId = priorRun.rows[0]?.id;

        const priorItemsBySourceId = new Map<string, string>();
        if (priorRunId) {
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
              priorItemsBySourceId.set(row.source_item_id, row.id);
            }
          }
        }

        const items = await this.insertRunItems(
          client,
          inserted.id,
          input.checklistItems,
          priorItemsBySourceId,
        );
        return { created: true, run: inserted, items };
      }

      const existingResult = await client.query<QaVerificationRunRow>(
        `
          SELECT * FROM projects.qa_verification_runs
          WHERE project_id = $1 AND checklist_id = $2 AND branch = $3 AND commit_sha = $4;
        `,
        [input.projectId, input.checklistId, input.branch, input.commitSha],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        // Unreachable in practice: the INSERT conflicted on this exact
        // unique key, so a row satisfying it must exist. Fails loudly rather
        // than returning an unsound result if that invariant is ever wrong.
        throw new Error(
          'qa_verification_runs INSERT conflicted but no matching row was found',
        );
      }
      const itemsResult = await client.query<QaRunItemRow>(
        `SELECT * FROM projects.qa_run_items WHERE run_id = $1 ORDER BY "position";`,
        [existing.id],
      );
      return { created: false, run: existing, items: itemsResult.rows };
    });
  }

  private async insertRunItems(
    client: Pick<PoolClient, 'query'>,
    runId: string,
    checklistItems: QaChecklistItemRow[],
    priorItemsBySourceId: Map<string, string>,
  ): Promise<QaRunItemRow[]> {
    if (checklistItems.length === 0) {
      return [];
    }

    const values: unknown[] = [runId];
    const rowsSql = checklistItems
      .map((item) => {
        const base = values.length;
        values.push(
          item.id,
          priorItemsBySourceId.get(item.id) ?? null,
          item.position,
          item.title,
          item.description,
          item.target_persona,
          item.verification_type,
          item.test_identifier,
        );
        return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      })
      .join(',\n');

    const result = await client.query<QaRunItemRow>(
      `
        INSERT INTO projects.qa_run_items (
          run_id, source_item_id, prior_run_item_id, "position", title,
          description, target_persona, verification_type, test_identifier
        )
        VALUES ${rowsSql}
        RETURNING *;
      `,
      values,
    );
    return result.rows.sort((a, b) => a.position - b.position);
  }

  async findRunForProject(
    projectId: string,
    runId: string,
  ): Promise<QaVerificationRunRow | null> {
    const result = await this.databaseService.query<QaVerificationRunRow>(
      `SELECT * FROM projects.qa_verification_runs WHERE id = $1 AND project_id = $2 AND scope = 'repository';`,
      [runId, projectId],
    );
    return result.rows[0] ?? null;
  }

  async findRunByKey(
    projectId: string,
    checklistId: string,
    branch: string,
    commitSha: string,
  ): Promise<QaVerificationRunRow | null> {
    const result = await this.databaseService.query<QaVerificationRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE project_id = $1 AND checklist_id = $2 AND branch = $3 AND commit_sha = $4;
      `,
      [projectId, checklistId, branch, commitSha],
    );
    return result.rows[0] ?? null;
  }

  async listRunsForProject(
    projectId: string,
    filter: {
      branch: string | null;
      checklistId: string | null;
      limit: number;
    },
  ): Promise<QaVerificationRunRow[]> {
    const conditions = ['project_id = $1'];
    const values: unknown[] = [projectId];
    if (filter.branch) {
      values.push(filter.branch);
      conditions.push(`branch = $${values.length}`);
    }
    if (filter.checklistId) {
      values.push(filter.checklistId);
      conditions.push(`checklist_id = $${values.length}`);
    }
    values.push(filter.limit);
    const limitParam = `$${values.length}`;

    const result = await this.databaseService.query<QaVerificationRunRow>(
      `
        SELECT * FROM projects.qa_verification_runs
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ${limitParam};
      `,
      values,
    );
    return result.rows;
  }

  async listItemsByRunId(runId: string): Promise<QaRunItemRow[]> {
    const result = await this.databaseService.query<QaRunItemRow>(
      `SELECT * FROM projects.qa_run_items WHERE run_id = $1 ORDER BY "position";`,
      [runId],
    );
    return result.rows;
  }

  async listItemsByRunIds(
    runIds: string[],
  ): Promise<Map<string, QaRunItemRow[]>> {
    const map = new Map<string, QaRunItemRow[]>();
    if (runIds.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<QaRunItemRow>(
      `
        SELECT * FROM projects.qa_run_items
        WHERE run_id = ANY($1::uuid[])
        ORDER BY run_id, "position";
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

  async findItemForRun(
    runId: string,
    itemId: string,
  ): Promise<QaRunItemRow | null> {
    const result = await this.databaseService.query<QaRunItemRow>(
      `SELECT * FROM projects.qa_run_items WHERE id = $1 AND run_id = $2;`,
      [itemId, runId],
    );
    return result.rows[0] ?? null;
  }

  async findActiveSignoffsByRunIds(
    runIds: string[],
  ): Promise<Map<string, QaRunSignoffRow>> {
    const map = new Map<string, QaRunSignoffRow>();
    if (runIds.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<QaRunSignoffRow>(
      `
        SELECT * FROM projects.qa_run_signoffs
        WHERE run_id = ANY($1::uuid[]) AND superseded_at IS NULL;
      `,
      [runIds],
    );
    for (const row of result.rows) {
      map.set(row.run_id, row);
    }
    return map;
  }

  async findActiveSignoff(runId: string): Promise<QaRunSignoffRow | null> {
    const map = await this.findActiveSignoffsByRunIds([runId]);
    return map.get(runId) ?? null;
  }

  /**
   * Resolves QaRunItem.previous: for each `prior_run_item_id` in `ids`, the
   * prior item's own status plus its RUN's id/commit_sha (a qa_run_items row
   * does not carry commit_sha itself — only its run does). Batched by the
   * caller across a whole run's items in one query rather than one lookup
   * per item.
   */
  async findPriorItemSummaries(
    ids: string[],
  ): Promise<
    Map<
      string,
      { runId: string; commitSha: string | null; status: QaRunItemStatus }
    >
  > {
    const map = new Map<
      string,
      { runId: string; commitSha: string | null; status: QaRunItemStatus }
    >();
    if (ids.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<{
      id: string;
      run_id: string;
      commit_sha: string | null;
      status: QaRunItemStatus;
    }>(
      `
        SELECT i.id, i.run_id, i.status, r.commit_sha
        FROM projects.qa_run_items i
        JOIN projects.qa_verification_runs r ON r.id = i.run_id
        WHERE i.id = ANY($1::uuid[]);
      `,
      [ids],
    );
    for (const row of result.rows) {
      map.set(row.id, {
        runId: row.run_id,
        commitSha: row.commit_sha,
        status: row.status,
      });
    }
    return map;
  }

  /**
   * Conditional UPDATE on (id, run_id, row_version) — 0 rows back means a
   * stale expectedRowVersion, the item does not belong to this run, or it
   * does not exist; the caller (which already read the row once to validate
   * persona/severity rules) turns that into the right 404 vs 409. Writes a
   * matching qa_run_item_events row in the same transaction whenever the
   * update itself succeeds. `previousStatus` is the pre-image status the
   * caller already read, used only as the event's `from_status`.
   */
  async updateItem(
    runId: string,
    itemId: string,
    expectedRowVersion: number,
    patch: UpdateQaRunItemPatch,
    actor: RunActor,
    previousStatus: QaRunItemStatus,
    rules?: QaProjectItemRules,
  ): Promise<QaRunItemRow | null> {
    return this.databaseService.withTransaction(async (client) => {
      // Lock order, everywhere: run row -> requirement item -> run item. A
      // Progress write only ever takes the requirement item, so no cycle.
      await lockOpenRunForItemWrite(client, runId);
      if (rules?.requireProgressDoneForPass && patch.status === 'passed') {
        await this.assertSourceProgressDone(client, runId, itemId);
      }
      if (rules?.requireTestCasesResolvedForPass && patch.status === 'passed') {
        await this.assertTestCasesResolved(client, runId, itemId);
      }
      const result = await client.query<QaRunItemRow>(
        `
          UPDATE projects.qa_run_items
          SET
            status = COALESCE($4, status),
            notes = CASE WHEN $5::boolean THEN $6 ELSE notes END,
            defect_severity = CASE WHEN $7::boolean THEN $8 ELSE defect_severity END,
            reproduction_steps = CASE WHEN $9::boolean THEN $10 ELSE reproduction_steps END,
            verified_by = CASE
              WHEN $4::text IS NULL THEN verified_by
              WHEN $4::text IN ('pending', 'in_progress') THEN NULL
              ELSE $11
            END,
            verified_by_login = CASE
              WHEN $4::text IS NULL THEN verified_by_login
              WHEN $4::text IN ('pending', 'in_progress') THEN NULL
              ELSE $12
            END,
            verified_at = CASE
              WHEN $4::text IS NULL THEN verified_at
              WHEN $4::text IN ('pending', 'in_progress') THEN NULL
              ELSE NOW()
            END,
            -- Returning an item to dev opens a new fix round: the previous
            -- round's "fixed, please re-test" request no longer applies (it
            -- stays in qa_run_item_events). Leaving it set made a re-returned
            -- item look already-fixed and hid the developer's re-test action.
            fix_requested_at = CASE WHEN $4::text = 'returned_to_dev' THEN NULL ELSE fix_requested_at END,
            fix_requested_by = CASE WHEN $4::text = 'returned_to_dev' THEN NULL ELSE fix_requested_by END,
            fix_requested_by_login = CASE WHEN $4::text = 'returned_to_dev' THEN NULL ELSE fix_requested_by_login END,
            fix_note = CASE WHEN $4::text = 'returned_to_dev' THEN NULL ELSE fix_note END,
            row_version = row_version + 1,
            updated_at = NOW()
          WHERE id = $1 AND run_id = $2 AND row_version = $3
          RETURNING *;
        `,
        [
          itemId,
          runId,
          expectedRowVersion,
          patch.status ?? null,
          patch.notes !== undefined,
          patch.notes ?? null,
          patch.defectSeverity !== undefined,
          patch.defectSeverity ?? null,
          patch.reproductionSteps !== undefined,
          patch.reproductionSteps ?? null,
          actor.id,
          actor.login,
        ],
      );

      const updated = result.rows[0];
      if (!updated) {
        return null;
      }

      const providedFields: Record<string, unknown> = {};
      if (patch.notes !== undefined) providedFields.notes = patch.notes;
      if (patch.defectSeverity !== undefined) {
        providedFields.defectSeverity = patch.defectSeverity;
      }
      if (patch.reproductionSteps !== undefined) {
        providedFields.reproductionSteps = patch.reproductionSteps;
      }

      await client.query(
        `
          INSERT INTO projects.qa_run_item_events (
            run_item_id, run_id, actor_user_id, actor_login, event_type,
            from_status, to_status, payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb);
        `,
        [
          itemId,
          runId,
          actor.id,
          actor.login,
          patch.status !== undefined ? 'status_changed' : 'edited',
          patch.status !== undefined ? previousStatus : null,
          patch.status ?? null,
          JSON.stringify(providedFields),
        ],
      );

      if (
        rules?.resetProgressOnReturn &&
        patch.status === 'returned_to_dev' &&
        updated.source_item_id
      ) {
        // QA sent it back, so the developer is working on it again.
        await client.query(
          `
            UPDATE projects.qa_checklist_items
            SET progress = 'in_progress', progress_by = $2, progress_by_login = $3,
                progress_at = NOW(), row_version = row_version + 1, updated_at = NOW()
            WHERE id = $1 AND progress <> 'in_progress';
          `,
          [updated.source_item_id, actor.id, actor.login],
        );
      }

      return updated;
    });
  }

  /**
   * Locks the run item (FOR UPDATE, so a test case result write, which takes
   * the same lock first, cannot slip in between) and refuses the pass while
   * any of its test cases is pending, failed or blocked.
   */
  private async assertTestCasesResolved(
    client: PoolClient,
    runId: string,
    itemId: string,
  ): Promise<void> {
    await client.query(
      `SELECT id FROM projects.qa_run_items WHERE id = $1 AND run_id = $2 FOR UPDATE;`,
      [itemId, runId],
    );
    const open = await client.query<{ n: number }>(
      `
        SELECT COUNT(*)::int AS n FROM projects.qa_run_test_cases
        WHERE run_item_id = $1 AND status IN ('pending', 'failed', 'blocked');
      `,
      [itemId],
    );
    const count = Number(open.rows[0]?.n ?? 0);
    if (count > 0) {
      throw new QaTestCasesOpenError(itemId, count);
    }
  }

  /**
   * Under a FOR SHARE lock on the source requirement item (so its Progress
   * cannot move until this transaction ends), refuses unless it is 'done'. A
   * run item whose source was deleted cannot be passed either.
   */
  private async assertSourceProgressDone(
    client: PoolClient,
    runId: string,
    itemId: string,
  ): Promise<void> {
    const source = await client.query<{ source_item_id: string | null }>(
      `SELECT source_item_id FROM projects.qa_run_items WHERE id = $1 AND run_id = $2;`,
      [itemId, runId],
    );
    const sourceItemId = source.rows[0]?.source_item_id;
    if (!sourceItemId) {
      throw new QaProgressNotDoneError(itemId);
    }
    const progress = await client.query<{ progress: string }>(
      `SELECT progress FROM projects.qa_checklist_items WHERE id = $1 FOR SHARE;`,
      [sourceItemId],
    );
    if (progress.rows[0]?.progress !== 'done') {
      throw new QaProgressNotDoneError(itemId);
    }
  }

  /**
   * Conditional on the item's CURRENT status already being 'returned_to_dev'
   * — that WHERE clause is itself the race-safe guard (the contract's
   * request-retest body carries no expectedRowVersion), so a 0-row result
   * means either the item does not belong to this run or it was not (or no
   * longer is) returned_to_dev.
   */
  async requestRetest(
    runId: string,
    itemId: string,
    actor: RunActor,
    note: string | null,
  ): Promise<QaRunItemRow | null> {
    return this.databaseService.withTransaction(async (client) => {
      await lockOpenRunForItemWrite(client, runId);
      const result = await client.query<QaRunItemRow>(
        `
          UPDATE projects.qa_run_items
          SET
            status = 'pending',
            fix_requested_at = NOW(),
            fix_requested_by = $3,
            fix_requested_by_login = $4,
            fix_note = $5,
            verified_by = NULL,
            verified_by_login = NULL,
            verified_at = NULL,
            row_version = row_version + 1,
            updated_at = NOW()
          WHERE id = $1 AND run_id = $2 AND status = 'returned_to_dev'
          RETURNING *;
        `,
        [itemId, runId, actor.id, actor.login, note],
      );

      const updated = result.rows[0];
      if (!updated) {
        return null;
      }

      await client.query(
        `
          INSERT INTO projects.qa_run_item_events (
            run_item_id, run_id, actor_user_id, actor_login, event_type,
            from_status, to_status, payload
          )
          VALUES ($1, $2, $3, $4, 'fix_requested', 'returned_to_dev', 'pending', $5::jsonb);
        `,
        [itemId, runId, actor.id, actor.login, JSON.stringify({ note })],
      );

      return updated;
    });
  }

  /**
   * Signs off an OPEN run: flips its status and inserts the (at most one
   * active, enforced by the partial unique index) signoff row in the same
   * transaction. Returns null if the run was not open (already signed off,
   * or does not exist) — the caller has already read the run once, so it
   * can tell those apart for the right 404 vs 409.
   */
  async createSignoff(
    input: CreateSignoffInput,
  ): Promise<{ run: QaAnyRunRow; signoff: QaRunSignoffRow } | null> {
    return this.databaseService.withTransaction(async (client) => {
      const locked = await client.query<{ status: string }>(
        `SELECT status FROM projects.qa_verification_runs WHERE id = $1 FOR UPDATE;`,
        [input.runId],
      );
      if (locked.rows[0]?.status !== 'open') {
        return null;
      }

      const fingerprint = await client.query<{
        count: string;
        row_version_sum: string;
      }>(
        `
          SELECT COUNT(*) AS count, COALESCE(SUM(row_version), 0) AS row_version_sum
          FROM projects.qa_run_items
          WHERE run_id = $1;
        `,
        [input.runId],
      );
      const current = fingerprint.rows[0];
      if (
        Number(current?.count ?? 0) !== input.expectedItems.count ||
        Number(current?.row_version_sum ?? 0) !==
          input.expectedItems.rowVersionSum
      ) {
        throw new QaRunItemsChangedError(input.runId);
      }
      if (input.expectedAttachmentIds !== undefined) {
        const attachments = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM projects.qa_run_item_attachments WHERE run_id = $1;`,
          [input.runId],
        );
        if (
          !sameIds(
            attachments.rows.map((row) => row.id),
            input.expectedAttachmentIds,
          )
        ) {
          throw new QaRunItemsChangedError(input.runId);
        }
      }

      const runResult = await client.query<QaAnyRunRow>(
        `
          UPDATE projects.qa_verification_runs
          SET status = 'signed_off', updated_at = $2
          WHERE id = $1 AND status = 'open'
          RETURNING *;
        `,
        [input.runId, input.signedAt],
      );
      const run = runResult.rows[0];
      if (!run) {
        return null;
      }

      const signoffResult = await client.query<QaRunSignoffRow>(
        `
          INSERT INTO projects.qa_run_signoffs (
            id, run_id, verdict, summary, conditions, signed_by, signed_by_login, signed_at, report_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          RETURNING *;
        `,
        [
          input.id,
          input.runId,
          input.verdict,
          input.summary,
          input.conditions,
          input.signedBy,
          input.signedByLogin,
          input.signedAt,
          JSON.stringify(input.reportJson),
        ],
      );
      const signoff = signoffResult.rows[0];
      if (!signoff) {
        throw new Error('qa_run_signoffs INSERT returned no row');
      }

      return { run, signoff };
    });
  }

  /**
   * Reopens a SIGNED_OFF run and supersedes its active signoff in the same
   * transaction. Returns null if the run was not signed off.
   */
  async reopenRun(runId: string, actor: RunActor): Promise<QaAnyRunRow | null> {
    return this.databaseService.withTransaction(async (client) => {
      const runResult = await client.query<QaAnyRunRow>(
        `
          UPDATE projects.qa_verification_runs
          SET status = 'open', updated_at = NOW()
          WHERE id = $1 AND status = 'signed_off'
          RETURNING *;
        `,
        [runId],
      );
      const run = runResult.rows[0];
      if (!run) {
        return null;
      }

      await client.query(
        `
          UPDATE projects.qa_run_signoffs
          SET superseded_at = NOW(), superseded_by = $2, superseded_by_login = $3
          WHERE run_id = $1 AND superseded_at IS NULL;
        `,
        [runId, actor.id, actor.login],
      );

      return run;
    });
  }

  /**
   * Every superseded sign-off for a run, oldest first -- the QA report
   * export's signoffHistory (Slice 4). The active (non-superseded) signoff
   * is never included here; it is surfaced separately as run.signoff.
   */
  async listSupersededSignoffs(runId: string): Promise<QaRunSignoffRow[]> {
    const result = await this.databaseService.query<QaRunSignoffRow>(
      `
        SELECT * FROM projects.qa_run_signoffs
        WHERE run_id = $1 AND superseded_at IS NOT NULL
        ORDER BY signed_at ASC;
      `,
      [runId],
    );
    return result.rows;
  }

  /**
   * Items currently returned_to_dev across the project's OPEN runs, newest
   * touched first. Scoped to open runs only: a signed-off run is frozen —
   * its report already speaks for it — so a returned item inside one would
   * be stale, actionless noise on a "needs your attention" list.
   */
  async listReturnedItemsForProject(
    projectId: string,
  ): Promise<QaReturnedItemRow[]> {
    const result = await this.databaseService.query<
      QaRunItemRow & {
        run_branch: string;
        run_commit_sha: string;
        run_checklist_name: string;
      }
    >(
      `
        SELECT
          i.*,
          r.branch AS run_branch,
          r.commit_sha AS run_commit_sha,
          r.checklist_name AS run_checklist_name
        FROM projects.qa_run_items i
        JOIN projects.qa_verification_runs r ON r.id = i.run_id
        WHERE r.project_id = $1
          AND r.status = 'open'
          AND i.status = 'returned_to_dev'
        ORDER BY i.updated_at DESC;
      `,
      [projectId],
    );
    return result.rows.map((row) => ({
      item: row,
      runBranch: row.run_branch,
      runCommitSha: row.run_commit_sha,
      runChecklistName: row.run_checklist_name,
    }));
  }

  /**
   * Open, developer-targeted items on the project's OPEN runs for `branch`
   * (the "My QA items" feed's developerItems half -- see
   * QaRunsService.listMyItems). Excludes 'passed' and 'returned_to_dev':
   * passed needs no action, and a returned item already surfaces in
   * listReturnedItemsForProject above -- a developer should not see it
   * twice under two different labels. Newest run first (r.created_at DESC),
   * then item position for a stable order within a run.
   */
  async listOpenDeveloperItemsForProject(
    projectId: string,
    branch: string,
  ): Promise<QaReturnedItemRow[]> {
    const result = await this.databaseService.query<
      QaRunItemRow & {
        run_branch: string;
        run_commit_sha: string;
        run_checklist_name: string;
      }
    >(
      `
        SELECT
          i.*,
          r.branch AS run_branch,
          r.commit_sha AS run_commit_sha,
          r.checklist_name AS run_checklist_name
        FROM projects.qa_run_items i
        JOIN projects.qa_verification_runs r ON r.id = i.run_id
        WHERE r.project_id = $1
          AND r.branch = $2
          AND r.status = 'open'
          AND i.target_persona = 'developer'
          AND i.status NOT IN ('passed', 'returned_to_dev')
        ORDER BY r.created_at DESC, i."position" ASC;
      `,
      [projectId, branch],
    );
    return result.rows.map((row) => ({
      item: row,
      runBranch: row.run_branch,
      runCommitSha: row.run_commit_sha,
      runChecklistName: row.run_checklist_name,
    }));
  }
}
