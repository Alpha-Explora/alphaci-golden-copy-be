import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

import type { DatabaseService } from '../../src/kernel/db/database.service';
import {
  QaRunsRepository,
  QaTestCasesOpenError,
} from '../../src/modules/projects/infrastructure/qa-runs.repository';
import { QaTestCasesRepository } from '../../src/modules/projects/infrastructure/qa-test-cases.repository';

/**
 * Applies the whole migration tree to an EMPTY database, then exercises the
 * test case tables through the real repositories: the open-run sync, the
 * strict pass, a frozen signed-off run, a re-run of the migration and the
 * fail-closed rollback. Real Postgres, no mocks.
 *
 * Runs only when MIGRATION_TEST_DB_URL points at a throwaway, empty database
 * (same rule as project-requirements.migration.integration.spec.ts).
 */
const dbUrl = process.env['MIGRATION_TEST_DB_URL'];
const describeDatabase = dbUrl ? describe : describe.skip;

const MIGRATION = join('projects', '20261020010000_qa_test_cases.sql');
const ROLLBACK = resolve(
  __dirname,
  '../../supabase/rollbacks/20261020010000_qa_test_cases_down.sql',
);
const migrationsRoot = resolve(__dirname, '../../supabase/migrations');

function migrationFiles(dir: string, relative = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const name = join(relative, entry.name);
    if (entry.isDirectory()) return migrationFiles(full, name);
    return entry.name.endsWith('.sql') ? [name] : [];
  });
}

const orderedFiles = migrationFiles(migrationsRoot).sort((a, b) =>
  basename(a).localeCompare(basename(b)),
);

describeDatabase('qa_test_cases migration and repository', () => {
  const client = new Client({ connectionString: dbUrl });
  const owner = randomUUID();
  const workspaceId = randomUUID();
  const deliveryProject = randomUUID();
  const actor = { id: owner, login: 'qa' };
  let iterationId = '';
  let storyId = '';
  let runId = '';
  let runItemId = '';

  const asDatabaseService = (): DatabaseService =>
    ({
      query: (sql: string, values?: unknown[]) => client.query(sql, values),
      withClient: <T>(fn: (c: PoolClient) => Promise<T>) =>
        fn(client as unknown as PoolClient),
      withTransaction: async <T>(fn: (c: PoolClient) => Promise<T>) => {
        await client.query('BEGIN');
        try {
          const result = await fn(client as unknown as PoolClient);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    }) as unknown as DatabaseService;

  const testCases = () => new QaTestCasesRepository(asDatabaseService());
  const runs = () => new QaRunsRepository(asDatabaseService());

  const copies = async () =>
    (
      await client.query<{
        title: string;
        status: string;
        source: string | null;
      }>(
        'SELECT title, status, source_test_case_id AS source FROM projects.qa_run_test_cases WHERE run_id = $1 ORDER BY category_position, "position";',
        [runId],
      )
    ).rows;
  const runItemVersion = async () =>
    Number(
      (
        await client.query<{ row_version: number }>(
          'SELECT row_version FROM projects.qa_run_items WHERE id = $1;',
          [runItemId],
        )
      ).rows[0]?.row_version,
    );

  beforeAll(async () => {
    await client.connect();
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
       END $$;
       CREATE SCHEMA IF NOT EXISTS extensions;`,
    );
    for (const file of orderedFiles) {
      await client.query(readFileSync(join(migrationsRoot, file), 'utf8'));
    }

    await client.query(
      "INSERT INTO identity.app_users (id, login) VALUES ($1, 'qa');",
      [owner],
    );
    await client.query(
      "INSERT INTO orgs.workspaces (id, owner_user_id, name, kind) VALUES ($1, $2, 'Team', 'team');",
      [workspaceId, owner],
    );
    iterationId = (
      await client.query<{ id: string }>(
        'INSERT INTO projects.project_iterations (delivery_project_id, number) VALUES ($1, 1) RETURNING id;',
        [deliveryProject],
      )
    ).rows[0]!.id;
    const feature = (
      await client.query<{ id: string }>(
        `INSERT INTO projects.qa_checklists
           (workspace_id, name, created_by, kind, delivery_project_id, iteration_id)
         VALUES ($1, 'Customer Authentication', $2, 'functional', $3, $4) RETURNING id;`,
        [workspaceId, owner, deliveryProject, iterationId],
      )
    ).rows[0]!.id;
    storyId = (
      await client.query<{ id: string }>(
        `INSERT INTO projects.qa_checklist_items (checklist_id, "position", title, progress)
         VALUES ($1, 0, 'Returning customer logs in', 'done') RETURNING id;`,
        [feature],
      )
    ).rows[0]!.id;
    runId = (
      await client.query<{ id: string }>(
        `INSERT INTO projects.qa_verification_runs
           (scope, delivery_project_id, iteration_id, heads_fingerprint, checklist_version,
            checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('project', $1, $2, $3, 0, 'Checkout', 'uat', 'branch_head', $4, 'qa')
         RETURNING id;`,
        [deliveryProject, iterationId, 'a'.repeat(64), owner],
      )
    ).rows[0]!.id;
    runItemId = (
      await client.query<{ id: string }>(
        `INSERT INTO projects.qa_run_items
           (run_id, source_item_id, "position", title, target_persona, verification_type,
            requirement_id, requirement_name, requirement_kind)
         VALUES ($1, $2, 0, 'Returning customer logs in', 'all', 'manual', $3,
                 'Customer Authentication', 'functional')
         RETURNING id;`,
        [runId, storyId, feature],
      )
    ).rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await client.end();
  });

  it('copies a new test case into the open run as pending and bumps the story', async () => {
    const repository = testCases();
    const category = await repository.createCategory(
      storyId,
      'Happy path',
      owner,
      iterationId,
    );
    expect(await copies()).toEqual([]);

    const before = await runItemVersion();
    await repository.createTestCase(
      category.id,
      {
        title: 'Logs in with a saved password',
        expectedResult: 'Profile in the header',
      },
      owner,
      iterationId,
    );

    expect(await copies()).toEqual([
      expect.objectContaining({
        title: 'Logs in with a saved password',
        status: 'pending',
      }),
    ]);
    expect(await runItemVersion()).toBe(before + 1);
  });

  it('refuses a duplicate category name on the same story, case-insensitively', async () => {
    await expect(
      testCases().createCategory(storyId, 'HAPPY PATH', owner, iterationId),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses to pass the story while a test case is open, then passes once it is resolved', async () => {
    const pass = async () =>
      runs().updateItem(
        runId,
        runItemId,
        await runItemVersion(),
        {
          status: 'passed',
          notes: undefined,
          defectSeverity: undefined,
          reproductionSteps: undefined,
        },
        actor,
        'pending',
        {
          requireProgressDoneForPass: true,
          resetProgressOnReturn: true,
          requireTestCasesResolvedForPass: true,
        },
      );
    await expect(pass()).rejects.toBeInstanceOf(QaTestCasesOpenError);

    const copy = (
      await client.query<{ id: string; row_version: number }>(
        'SELECT id, row_version FROM projects.qa_run_test_cases WHERE run_id = $1;',
        [runId],
      )
    ).rows[0]!;
    const recorded = await testCases().recordResult(
      runId,
      runItemId,
      copy.id,
      copy.row_version,
      { status: 'passed', notes: 'Header shows the avatar' },
      actor,
    );
    expect(recorded).toMatchObject({
      status: 'passed',
      verified_by_login: 'qa',
    });
    // A stale row version is refused.
    await expect(
      testCases().recordResult(
        runId,
        runItemId,
        copy.id,
        copy.row_version,
        { status: 'failed', notes: undefined },
        actor,
      ),
    ).resolves.toBeNull();

    await expect(pass()).resolves.toMatchObject({ status: 'passed' });
  });

  it('an edit follows into the open run and keeps the result; a new case joins pending; a deleted one leaves', async () => {
    const repository = testCases();
    const [definition] =
      (await repository.listByItemIds([storyId])).get(storyId) ?? [];
    const first = definition!.cases[0]!;
    await repository.updateTestCase(
      first.id,
      first.row_version,
      { title: 'Logs in (saved password)' },
      iterationId,
    );
    const second = await repository.createTestCase(
      definition!.category.id,
      { title: 'Logs in after the session expired', expectedResult: null },
      owner,
      iterationId,
    );

    expect(await copies()).toEqual([
      expect.objectContaining({
        title: 'Logs in (saved password)',
        status: 'passed',
      }),
      expect.objectContaining({
        title: 'Logs in after the session expired',
        status: 'pending',
      }),
    ]);
    expect(await repository.countOpenForRun(runId)).toBe(1);

    await repository.deleteTestCase(second.id, iterationId);
    expect(await copies()).toHaveLength(1);
    expect(await repository.countOpenForRun(runId)).toBe(0);
  });

  it('a signed-off run keeps its copies when the definitions change', async () => {
    await client.query(
      "UPDATE projects.qa_verification_runs SET status = 'signed_off' WHERE id = $1;",
      [runId],
    );
    const repository = testCases();
    const [definition] =
      (await repository.listByItemIds([storyId])).get(storyId) ?? [];
    await repository.deleteCategory(
      storyId,
      definition!.category.id,
      iterationId,
    );

    expect(await copies()).toEqual([
      expect.objectContaining({
        title: 'Logs in (saved password)',
        status: 'passed',
        source: null,
      }),
    ]);
  });

  it('re-runs cleanly, and the rollback fails closed while rows exist', async () => {
    await client.query(readFileSync(join(migrationsRoot, MIGRATION), 'utf8'));

    await expect(client.query(readFileSync(ROLLBACK, 'utf8'))).rejects.toThrow(
      'QA test cases or test case results exist',
    );
    await client.query('ROLLBACK');
    await client.query('DELETE FROM projects.qa_run_test_cases;');
    await client.query(readFileSync(ROLLBACK, 'utf8'));
    expect(
      (
        await client.query(
          "SELECT to_regclass('projects.qa_run_test_cases') AS t;",
        )
      ).rows[0]?.t,
    ).toBeNull();
    await client.query(readFileSync(join(migrationsRoot, MIGRATION), 'utf8'));
  });
});
