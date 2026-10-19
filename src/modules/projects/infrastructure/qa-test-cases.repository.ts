import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  TestCase,
  TestCaseCategory,
} from '../application/qa-checklists/qa-requirements.contracts';
import type { QaTestCaseStatus } from '../application/qa-runs/qa-runs.contracts';
import { lockOpenRunForItemWrite, type RunActor } from './qa-runs.repository';

export interface QaTestCaseCategoryRow {
  id: string;
  item_id: string;
  position: number;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface QaTestCaseRow {
  id: string;
  category_id: string;
  position: number;
  title: string;
  expected_result: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface QaRunTestCaseRow {
  id: string;
  run_id: string;
  run_item_id: string;
  source_test_case_id: string | null;
  source_category_id: string | null;
  category_name: string;
  category_position: number;
  position: number;
  title: string;
  expected_result: string | null;
  status: QaTestCaseStatus;
  notes: string | null;
  verified_by: string | null;
  verified_by_login: string | null;
  verified_at: string | null;
  row_version: number;
  updated_at: string;
}

/** A category definition with its cases, for one story. */
export interface QaTestCategoryDefinition {
  category: QaTestCaseCategoryRow;
  cases: QaTestCaseRow[];
}

/** `undefined` = leave unchanged; `null` clears expectedResult. */
export interface UpdateTestCasePatch {
  title?: string;
  expectedResult?: string | null;
}

/** `undefined` = leave unchanged; `null` clears notes. */
export interface RecordTestCaseResultPatch {
  status: QaTestCaseStatus | undefined;
  notes: string | null | undefined;
}

/**
 * Brings every OPEN Project run of an Iteration in line with the test case
 * definitions of its stories: copies new test cases in as pending, updates
 * the snapshot columns of edited ones (their result stays), and drops copies
 * whose definition was deleted. Signed-off runs are never touched.
 *
 * Takes the open run rows FOR SHARE first (the lock every run item write
 * takes), so a sign-off, which takes FOR UPDATE, serializes with it. Every
 * story whose copies changed gets its run item's row_version bumped: that is
 * what the sign-off's item fingerprint compares, so a test case change in
 * the middle of a sign-off is refused as "the run changed".
 *
 * Then it locks (FOR UPDATE, in id order) every run item that has a copy or
 * whose story has a category, BEFORE touching a copy: the lock order of a
 * result write is run, run item, test case, and this keeps to it.
 *
 * Returns how many run items were bumped.
 */
export async function syncOpenRunTestCases(
  client: PoolClient,
  iterationId: string,
): Promise<number> {
  const open = await client.query<{ id: string }>(
    `
      SELECT id FROM projects.qa_verification_runs
      WHERE scope = 'project' AND iteration_id = $1 AND status = 'open'
      ORDER BY id
      FOR SHARE;
    `,
    [iterationId],
  );
  const runIds = open.rows.map((row) => row.id);
  if (runIds.length === 0) {
    return 0;
  }
  await client.query(
    `
      SELECT ri.id FROM projects.qa_run_items ri
      WHERE ri.run_id = ANY($1::uuid[])
        AND (
          EXISTS (SELECT 1 FROM projects.qa_run_test_cases rtc WHERE rtc.run_item_id = ri.id)
          OR EXISTS (
            SELECT 1 FROM projects.qa_test_case_categories cat
            WHERE cat.item_id = ri.source_item_id
          )
        )
      ORDER BY ri.id
      FOR UPDATE;
    `,
    [runIds],
  );

  const removed = await client.query<{ run_item_id: string }>(
    `
      DELETE FROM projects.qa_run_test_cases
      WHERE run_id = ANY($1::uuid[]) AND source_test_case_id IS NULL
      RETURNING run_item_id;
    `,
    [runIds],
  );
  const upserted = await client.query<{ run_item_id: string }>(
    `
      INSERT INTO projects.qa_run_test_cases AS rtc (
        run_id, run_item_id, source_test_case_id, source_category_id,
        category_name, category_position, "position", title, expected_result
      )
      SELECT ri.run_id, ri.id, tc.id, cat.id, cat.name, cat."position",
             tc."position", tc.title, tc.expected_result
      FROM projects.qa_run_items ri
      JOIN projects.qa_test_case_categories cat ON cat.item_id = ri.source_item_id
      JOIN projects.qa_test_cases tc ON tc.category_id = cat.id
      WHERE ri.run_id = ANY($1::uuid[])
      ON CONFLICT (run_item_id, source_test_case_id) DO UPDATE SET
        source_category_id = EXCLUDED.source_category_id,
        category_name = EXCLUDED.category_name,
        category_position = EXCLUDED.category_position,
        "position" = EXCLUDED."position",
        title = EXCLUDED.title,
        expected_result = EXCLUDED.expected_result,
        updated_at = NOW()
      WHERE (
        rtc.source_category_id,
        rtc.category_name,
        rtc.category_position,
        rtc."position",
        rtc.title,
        rtc.expected_result
      ) IS DISTINCT FROM (
        EXCLUDED.source_category_id,
        EXCLUDED.category_name,
        EXCLUDED.category_position,
        EXCLUDED."position",
        EXCLUDED.title,
        EXCLUDED.expected_result
      )
      RETURNING rtc.run_item_id;
    `,
    [runIds],
  );

  const changed = [
    ...new Set(
      [...removed.rows, ...upserted.rows].map((row) => row.run_item_id),
    ),
  ];
  if (changed.length > 0) {
    await client.query(
      `
        UPDATE projects.qa_run_items
        SET row_version = row_version + 1, updated_at = NOW()
        WHERE id = ANY($1::uuid[]);
      `,
      [changed],
    );
  }
  return changed.length;
}

export function toTestCase(row: QaTestCaseRow): TestCase {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    expectedResult: row.expected_result,
    rowVersion: row.row_version,
  };
}

export function toTestCategories(
  definitions: readonly QaTestCategoryDefinition[],
): TestCaseCategory[] {
  return definitions.map(({ category, cases }) => ({
    id: category.id,
    position: category.position,
    name: category.name,
    rowVersion: category.row_version,
    testCases: cases.map(toTestCase),
  }));
}

/**
 * QA's test cases: categories and cases under a User story (the definitions),
 * and each Project run's copy of them with QA's result. Every definition
 * write re-syncs the Iteration's open runs in the same transaction, so a run
 * never shows a test case its story no longer has, nor misses a new one.
 */
@Injectable()
export class QaTestCasesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Every story's categories (with cases), each in position order. Stories with none are absent. */
  async listByItemIds(
    itemIds: readonly string[],
  ): Promise<Map<string, QaTestCategoryDefinition[]>> {
    const map = new Map<string, QaTestCategoryDefinition[]>();
    if (itemIds.length === 0) {
      return map;
    }
    const [categories, cases] = await Promise.all([
      this.databaseService.query<QaTestCaseCategoryRow>(
        `
          SELECT * FROM projects.qa_test_case_categories
          WHERE item_id = ANY($1::uuid[])
          ORDER BY item_id, "position", id;
        `,
        [itemIds],
      ),
      this.databaseService.query<QaTestCaseRow>(
        `
          SELECT tc.* FROM projects.qa_test_cases tc
          JOIN projects.qa_test_case_categories cat ON cat.id = tc.category_id
          WHERE cat.item_id = ANY($1::uuid[])
          ORDER BY tc.category_id, tc."position", tc.id;
        `,
        [itemIds],
      ),
    ]);
    const casesByCategory = new Map<string, QaTestCaseRow[]>();
    for (const row of cases.rows) {
      const list = casesByCategory.get(row.category_id) ?? [];
      list.push(row);
      casesByCategory.set(row.category_id, list);
    }
    for (const category of categories.rows) {
      const list = map.get(category.item_id) ?? [];
      list.push({ category, cases: casesByCategory.get(category.id) ?? [] });
      map.set(category.item_id, list);
    }
    return map;
  }

  async findCategory(
    itemId: string,
    categoryId: string,
  ): Promise<QaTestCaseCategoryRow | null> {
    const result = await this.databaseService.query<QaTestCaseCategoryRow>(
      `SELECT * FROM projects.qa_test_case_categories WHERE id = $1 AND item_id = $2;`,
      [categoryId, itemId],
    );
    return result.rows[0] ?? null;
  }

  /** The test case, only when it belongs to a category of `itemId`. */
  async findTestCase(
    itemId: string,
    testCaseId: string,
  ): Promise<QaTestCaseRow | null> {
    const result = await this.databaseService.query<QaTestCaseRow>(
      `
        SELECT tc.* FROM projects.qa_test_cases tc
        JOIN projects.qa_test_case_categories cat ON cat.id = tc.category_id
        WHERE tc.id = $1 AND cat.item_id = $2;
      `,
      [testCaseId, itemId],
    );
    return result.rows[0] ?? null;
  }

  async countCategories(itemId: string): Promise<number> {
    const result = await this.databaseService.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM projects.qa_test_case_categories WHERE item_id = $1;`,
      [itemId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async countTestCases(categoryId: string): Promise<number> {
    const result = await this.databaseService.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM projects.qa_test_cases WHERE category_id = $1;`,
      [categoryId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Appends a category after the story's last one. A duplicate name raises the pg unique violation. */
  async createCategory(
    itemId: string,
    name: string,
    createdBy: string,
    iterationId: string | null,
  ): Promise<QaTestCaseCategoryRow> {
    return this.write(iterationId, async (client) => {
      const result = await client.query<QaTestCaseCategoryRow>(
        `
          INSERT INTO projects.qa_test_case_categories (item_id, "position", name, created_by)
          SELECT $1, COALESCE(MAX("position") + 1, 0), $2, $3
          FROM projects.qa_test_case_categories
          WHERE item_id = $1
          RETURNING *;
        `,
        [itemId, name, createdBy],
      );
      return requireRow(result.rows[0], 'qa_test_case_categories INSERT');
    });
  }

  /** Null = the row_version moved or the category is gone. */
  async renameCategory(
    itemId: string,
    categoryId: string,
    expectedRowVersion: number,
    name: string,
    iterationId: string | null,
  ): Promise<QaTestCaseCategoryRow | null> {
    return this.write(iterationId, async (client) => {
      const result = await client.query<QaTestCaseCategoryRow>(
        `
          UPDATE projects.qa_test_case_categories
          SET name = $4, row_version = row_version + 1, updated_at = NOW()
          WHERE id = $1 AND item_id = $2 AND row_version = $3
          RETURNING *;
        `,
        [categoryId, itemId, expectedRowVersion, name],
      );
      return result.rows[0] ?? null;
    });
  }

  /** Deletes the category and its cases. False when it was not there. */
  async deleteCategory(
    itemId: string,
    categoryId: string,
    iterationId: string | null,
  ): Promise<boolean> {
    return this.write(iterationId, async (client) => {
      const result = await client.query(
        `DELETE FROM projects.qa_test_case_categories WHERE id = $1 AND item_id = $2;`,
        [categoryId, itemId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /** Appends a test case after the category's last one. */
  async createTestCase(
    categoryId: string,
    input: { title: string; expectedResult: string | null },
    createdBy: string,
    iterationId: string | null,
  ): Promise<QaTestCaseRow> {
    return this.write(iterationId, async (client) => {
      const result = await client.query<QaTestCaseRow>(
        `
          INSERT INTO projects.qa_test_cases (
            category_id, "position", title, expected_result, created_by
          )
          SELECT $1, COALESCE(MAX("position") + 1, 0), $2, $3, $4
          FROM projects.qa_test_cases
          WHERE category_id = $1
          RETURNING *;
        `,
        [categoryId, input.title, input.expectedResult, createdBy],
      );
      return requireRow(result.rows[0], 'qa_test_cases INSERT');
    });
  }

  /** Null = the row_version moved or the test case is gone. */
  async updateTestCase(
    testCaseId: string,
    expectedRowVersion: number,
    patch: UpdateTestCasePatch,
    iterationId: string | null,
  ): Promise<QaTestCaseRow | null> {
    return this.write(iterationId, async (client) => {
      const result = await client.query<QaTestCaseRow>(
        `
          UPDATE projects.qa_test_cases
          SET
            title = COALESCE($3, title),
            expected_result = CASE WHEN $4::boolean THEN $5 ELSE expected_result END,
            row_version = row_version + 1,
            updated_at = NOW()
          WHERE id = $1 AND row_version = $2
          RETURNING *;
        `,
        [
          testCaseId,
          expectedRowVersion,
          patch.title ?? null,
          patch.expectedResult !== undefined,
          patch.expectedResult ?? null,
        ],
      );
      return result.rows[0] ?? null;
    });
  }

  /** False when it was not there. */
  async deleteTestCase(
    testCaseId: string,
    iterationId: string | null,
  ): Promise<boolean> {
    return this.write(iterationId, async (client) => {
      const result = await client.query(
        `DELETE FROM projects.qa_test_cases WHERE id = $1;`,
        [testCaseId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /** Brings the Iteration's open runs in line with the definitions (see syncOpenRunTestCases). */
  async syncOpenRuns(iterationId: string): Promise<number> {
    return this.databaseService.withTransaction((client) =>
      syncOpenRunTestCases(client, iterationId),
    );
  }

  /** One run's test case copies, by story, category and position. */
  async listForRun(runId: string): Promise<QaRunTestCaseRow[]> {
    const result = await this.databaseService.query<QaRunTestCaseRow>(
      `
        SELECT * FROM projects.qa_run_test_cases
        WHERE run_id = $1
        ORDER BY run_item_id, category_position, "position", id;
      `,
      [runId],
    );
    return result.rows;
  }

  /** How many of a run's test cases are still pending, failed or blocked. */
  async countOpenForRun(runId: string): Promise<number> {
    const result = await this.databaseService.query<{ n: number }>(
      `
        SELECT COUNT(*)::int AS n FROM projects.qa_run_test_cases
        WHERE run_id = $1 AND status IN ('pending', 'failed', 'blocked');
      `,
      [runId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * Records QA's result on one test case of an open run. Lock order is the
   * one every run item write uses: the run row (FOR SHARE, refuses a run that
   * is no longer open with QaRunNotOpenError), then the run item (FOR UPDATE,
   * so a story pass that checks its test cases waits for this), then the test
   * case. Bumps the run item's row_version and writes an 'edited' item event.
   *
   * Null = the test case is not in that run item, or its row_version moved.
   */
  async recordResult(
    runId: string,
    runItemId: string,
    testCaseId: string,
    expectedRowVersion: number,
    patch: RecordTestCaseResultPatch,
    actor: RunActor,
  ): Promise<QaRunTestCaseRow | null> {
    return this.databaseService.withTransaction(async (client) => {
      await lockOpenRunForItemWrite(client, runId);
      const item = await client.query(
        `SELECT id FROM projects.qa_run_items WHERE id = $1 AND run_id = $2 FOR UPDATE;`,
        [runItemId, runId],
      );
      if (item.rows.length === 0) {
        return null;
      }
      const before = await client.query<{ status: QaTestCaseStatus }>(
        `SELECT status FROM projects.qa_run_test_cases WHERE id = $1 AND run_item_id = $2;`,
        [testCaseId, runItemId],
      );
      const result = await client.query<QaRunTestCaseRow>(
        `
          UPDATE projects.qa_run_test_cases
          SET
            status = COALESCE($4, status),
            notes = CASE WHEN $5::boolean THEN $6 ELSE notes END,
            verified_by = CASE
              WHEN $4::text IS NULL THEN verified_by
              WHEN $4::text = 'pending' THEN NULL
              ELSE $7::uuid
            END,
            verified_by_login = CASE
              WHEN $4::text IS NULL THEN verified_by_login
              WHEN $4::text = 'pending' THEN NULL
              ELSE $8
            END,
            verified_at = CASE
              WHEN $4::text IS NULL THEN verified_at
              WHEN $4::text = 'pending' THEN NULL
              ELSE NOW()
            END,
            row_version = row_version + 1,
            updated_at = NOW()
          WHERE id = $1 AND run_item_id = $2 AND row_version = $3
          RETURNING *;
        `,
        [
          testCaseId,
          runItemId,
          expectedRowVersion,
          patch.status ?? null,
          patch.notes !== undefined,
          patch.notes ?? null,
          actor.id,
          actor.login,
        ],
      );
      const updated = result.rows[0];
      if (!updated) {
        return null;
      }
      await client.query(
        `
          UPDATE projects.qa_run_items
          SET row_version = row_version + 1, updated_at = NOW()
          WHERE id = $1;
        `,
        [runItemId],
      );
      await client.query(
        `
          INSERT INTO projects.qa_run_item_events (
            run_item_id, run_id, actor_user_id, actor_login, event_type, payload
          )
          VALUES ($1, $2, $3, $4, 'edited', $5::jsonb);
        `,
        [
          runItemId,
          runId,
          actor.id,
          actor.login,
          JSON.stringify({
            testCase: {
              id: updated.id,
              title: updated.title,
              from: before.rows[0]?.status ?? null,
              to: updated.status,
              ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
            },
          }),
        ],
      );
      return updated;
    });
  }

  /** A definition write, then the open-run sync, in one transaction. */
  private async write<T>(
    iterationId: string | null,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.databaseService.withTransaction(async (client) => {
      const value = await run(client);
      if (iterationId) {
        await syncOpenRunTestCases(client, iterationId);
      }
      return value;
    });
  }
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (!row) {
    throw new Error(`projects.${what} returned no row`);
  }
  return row;
}
