import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

import type { DatabaseService } from '../../src/kernel/db/database.service';
import { QaProjectRunsRepository } from '../../src/modules/projects/infrastructure/qa-project-runs.repository';
import {
  QaRunNotSignedOffError,
  QaRunsRepository,
} from '../../src/modules/projects/infrastructure/qa-runs.repository';

/**
 * Applies the whole migration tree to an EMPTY database, then exercises the
 * Product owner's acceptance through the real repositories: the default, a
 * pass only on a signed-off run, the count the merge gate reads, the reset a
 * QA status write makes, a re-run of the migration and the rollback. Real
 * Postgres, no mocks (ADR-0014, amendment 12).
 *
 * Runs only when MIGRATION_TEST_DB_URL points at a throwaway, empty database
 * (same rule as qa-test-cases.migration.integration.spec.ts).
 */
const dbUrl = process.env['MIGRATION_TEST_DB_URL'];
const describeDatabase = dbUrl ? describe : describe.skip;

const MIGRATION = join('projects', '20261021010000_qa_po_acceptance.sql');
const ROLLBACK = resolve(
  __dirname,
  '../../supabase/rollbacks/20261021010000_qa_po_acceptance_down.sql',
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

describeDatabase('qa_po_acceptance migration and repository', () => {
  const client = new Client({ connectionString: dbUrl });
  const owner = randomUUID();
  const productOwner = { id: randomUUID(), login: 'po' };
  const qa = { id: owner, login: 'qa' };
  const workspaceId = randomUUID();
  const deliveryProject = randomUUID();
  let runId = '';
  const itemIds: string[] = [];

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

  const runs = () => new QaRunsRepository(asDatabaseService());
  const projectRuns = () => new QaProjectRunsRepository(asDatabaseService());
  const item = async (id: string) =>
    (
      await client.query<{
        status: string;
        row_version: number;
        po_status: string;
        po_by: string | null;
        po_by_login: string | null;
        po_at: Date | null;
      }>(
        'SELECT status, row_version, po_status, po_by, po_by_login, po_at FROM projects.qa_run_items WHERE id = $1;',
        [id],
      )
    ).rows[0]!;

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
    const iterationId = (
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
    for (const [position, title] of ['Logs in', 'Sees the profile'].entries()) {
      const story = (
        await client.query<{ id: string }>(
          `INSERT INTO projects.qa_checklist_items (checklist_id, "position", title, progress)
           VALUES ($1, $2, $3, 'done') RETURNING id;`,
          [feature, position, title],
        )
      ).rows[0]!.id;
      itemIds.push(
        (
          await client.query<{ id: string }>(
            `INSERT INTO projects.qa_run_items
               (run_id, source_item_id, "position", title, target_persona, verification_type,
                requirement_id, requirement_name, requirement_kind, status,
                verified_by, verified_by_login, verified_at)
             VALUES ($1, $2, $3, $4, 'all', 'manual', $5, 'Customer Authentication', 'functional', 'passed',
                     $6, 'qa', NOW())
             RETURNING id;`,
            [runId, story, position, title, feature, owner],
          )
        ).rows[0]!.id,
      );
    }
  }, 180_000);

  afterAll(async () => {
    await client.end();
  });

  it('starts every item pending, with no one recorded', async () => {
    expect(await item(itemIds[0]!)).toMatchObject({
      po_status: 'pending',
      po_by: null,
      po_by_login: null,
      po_at: null,
    });
  });

  it('refuses an acceptance while the run is open', async () => {
    const { row_version } = await item(itemIds[0]!);
    await expect(
      runs().acceptItem(runId, itemIds[0]!, row_version, productOwner),
    ).rejects.toBeInstanceOf(QaRunNotSignedOffError);
    expect((await item(itemIds[0]!)).po_status).toBe('pending');
  });

  it('accepts an item of a signed-off run, records who and when, and the gate counts the rest', async () => {
    await client.query(
      "UPDATE projects.qa_verification_runs SET status = 'signed_off' WHERE id = $1;",
      [runId],
    );
    expect(await projectRuns().countItemsNotAccepted(runId)).toBe(2);

    const before = await item(itemIds[0]!);
    const accepted = await runs().acceptItem(
      runId,
      itemIds[0]!,
      before.row_version,
      productOwner,
    );
    expect(accepted).toMatchObject({
      po_status: 'passed',
      po_by: productOwner.id,
      po_by_login: 'po',
      row_version: before.row_version + 1,
    });
    expect(accepted?.po_at).not.toBeNull();
    expect(await projectRuns().countItemsNotAccepted(runId)).toBe(1);

    const event = (
      await client.query<{ event_type: string; payload: unknown }>(
        'SELECT event_type, payload FROM projects.qa_run_item_events WHERE run_item_id = $1;',
        [itemIds[0]],
      )
    ).rows;
    expect(event).toEqual([
      { event_type: 'edited', payload: { poStatus: 'passed' } },
    ]);

    // A stale row version is refused without a change.
    await expect(
      runs().acceptItem(runId, itemIds[1]!, 999, productOwner),
    ).resolves.toBeNull();
    expect(await projectRuns().countItemsNotAccepted(runId)).toBe(1);
  });

  it('a QA status write after a reopen resets the acceptance', async () => {
    await runs().reopenRun(runId, productOwner);
    const before = await item(itemIds[0]!);
    const failed = await runs().updateItem(
      runId,
      itemIds[0]!,
      before.row_version,
      {
        status: 'failed',
        notes: 'Product owner: Wrong header',
        defectSeverity: 'major',
        reproductionSteps: undefined,
      },
      productOwner,
      'passed',
      {
        requireProgressDoneForPass: false,
        resetProgressOnReturn: true,
        requireTestCasesResolvedForPass: false,
      },
    );
    expect(failed).toMatchObject({
      status: 'failed',
      po_status: 'pending',
      po_by: null,
      po_by_login: null,
      po_at: null,
    });
    expect(await projectRuns().countItemsNotAccepted(runId)).toBe(2);

    // A notes-only edit leaves an acceptance alone.
    await client.query(
      "UPDATE projects.qa_run_items SET po_status = 'passed', po_by = $2, po_by_login = 'po', po_at = NOW() WHERE id = $1;",
      [itemIds[1], productOwner.id],
    );
    const other = await item(itemIds[1]!);
    await runs().updateItem(
      runId,
      itemIds[1]!,
      other.row_version,
      {
        status: undefined,
        notes: 'Looks right',
        defectSeverity: undefined,
        reproductionSteps: undefined,
      },
      qa,
      'passed',
    );
    expect((await item(itemIds[1]!)).po_status).toBe('passed');
  });

  it('refuses a po_status outside pending and passed', async () => {
    await expect(
      client.query(
        "UPDATE projects.qa_run_items SET po_status = 'failed' WHERE id = $1;",
        [itemIds[0]],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('re-runs cleanly, and the rollback removes the columns', async () => {
    await client.query(readFileSync(join(migrationsRoot, MIGRATION), 'utf8'));
    await client.query(readFileSync(ROLLBACK, 'utf8'));
    const columns = (
      await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'projects' AND table_name = 'qa_run_items'
           AND column_name LIKE 'po\\_%';`,
      )
    ).rows;
    expect(columns).toEqual([]);
    await client.query(readFileSync(join(migrationsRoot, MIGRATION), 'utf8'));
    expect((await item(itemIds[0]!)).po_status).toBe('pending');
  });
});
