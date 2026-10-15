import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

import type { DatabaseService } from '../../src/kernel/db/database.service';
import { ProjectIterationsRepository } from '../../src/modules/projects/infrastructure/project-iterations.repository';
import { QaChecklistsRepository } from '../../src/modules/projects/infrastructure/qa-checklists.repository';
import { QaProjectRunsRepository } from '../../src/modules/projects/infrastructure/qa-project-runs.repository';
import { QaRequirementsRepository } from '../../src/modules/projects/infrastructure/qa-requirements.repository';
import {
  QaProgressNotDoneError,
  QaRunsRepository,
} from '../../src/modules/projects/infrastructure/qa-runs.repository';

/**
 * Applies the whole migration tree to an EMPTY database, seeds the legacy QA
 * data shape, applies 20261001010000_project_requirements.sql, and applies it
 * (and the tree) again. Real Postgres, no mocks: this is what catches invalid
 * DDL that IF NOT EXISTS would otherwise hide.
 *
 * Runs only when MIGRATION_TEST_DB_URL points at a throwaway, empty database.
 * It deliberately does not reuse SUPABASE_DB_URL: replaying the tree against a
 * shared database would be destructive in the wrong places.
 */
const dbUrl = process.env['MIGRATION_TEST_DB_URL'];
const describeDatabase = dbUrl ? describe : describe.skip;

const MIGRATION = '20261001010000_project_requirements.sql';
const FIRST_QA_MIGRATION = '20260925010000_qa_checklists.sql';
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

async function applyFile(client: Client, file: string): Promise<void> {
  await client.query(readFileSync(join(migrationsRoot, file), 'utf8'));
}

async function count(client: Client, sql: string): Promise<number> {
  const result = await client.query<{ n: string }>(sql);
  return Number(result.rows[0]?.n ?? 0);
}

describeDatabase('project_requirements migration', () => {
  const client = new Client({ connectionString: dbUrl });
  const owner = randomUUID();
  const workspaceId = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  const projectC = randomUUID();
  const repoA1 = randomUUID();
  const repoB1 = randomUUID();
  const repoC1 = randomUUID();
  const repoA2 = randomUUID();
  const testChecklist = randomUUID();
  const johnsChecklist = randomUUID();
  const looseChecklist = randomUUID();
  const archivedProjectChecklist = randomUUID();
  const archivedRepoChecklist = randomUUID();

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

    // Everything before the migration under test: the shape production had.
    for (const file of orderedFiles) {
      if (basename(file) >= MIGRATION) break;
      await applyFile(client, file);
    }

    await seedLegacyData();
  }, 120_000);

  afterAll(async () => {
    await client.end();
  });

  async function seedLegacyData(): Promise<void> {
    await client.query(
      `INSERT INTO identity.app_users (id, login) VALUES ($1, 'owner');`,
      [owner],
    );
    await client.query(
      `INSERT INTO orgs.workspaces (id, owner_user_id, name, kind)
       VALUES ($1, $2, 'Team', 'team');`,
      [workspaceId, owner],
    );
    for (const [id, name, status, at] of [
      [projectA, 'Project A', 'active', '2026-01-01'],
      [projectB, 'Project B', 'active', '2026-02-01'],
      [projectC, 'Project C', 'archived', '2026-03-01'],
    ] as const) {
      const system = randomUUID();
      await client.query(
        `INSERT INTO hierarchy.systems (id, group_id, name) VALUES ($1, $2, $3);`,
        [system, workspaceId, name],
      );
      await client.query(
        `INSERT INTO hierarchy.delivery_projects (id, system_id, group_id, name, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [id, system, workspaceId, name, status, at],
      );
    }
    for (const [id, repo, dp, hierarchyStatus] of [
      [repoA1, 'acme/a1', projectA, 'active'],
      [repoA2, 'acme/a2', projectA, 'archived'],
      [repoB1, 'acme/b1', projectB, 'active'],
      [repoC1, 'acme/c1', projectC, 'active'],
    ] as const) {
      await client.query(
        `INSERT INTO projects.provisioned_projects
           (id, user_id, repo_full_name, template_id, service_name, workflow_path, workspace_id)
         VALUES ($1, $2, $3, 'tpl', $3, '.github/workflows/ci.yml', $4);`,
        [id, owner, repo, workspaceId],
      );
      await client.query(
        `INSERT INTO hierarchy.repositories
           (delivery_project_id, group_id, name, repo_full_name, status, provisioned_project_id)
         VALUES ($1, $2, $3, $3, $4, $5);`,
        [dp, workspaceId, repo, hierarchyStatus, id],
      );
    }

    const checklists: Array<[string, string, string[]]> = [
      [testChecklist, 'TestChecklist', [repoA1, repoB1]],
      [johnsChecklist, "John's Password", [repoB1]],
      [looseChecklist, 'Loose', []],
      [archivedProjectChecklist, 'Archived project', [repoC1]],
      [archivedRepoChecklist, 'Archived repo', [repoA2]],
    ];
    for (const [id, name, shares] of checklists) {
      await client.query(
        `INSERT INTO projects.qa_checklists (id, workspace_id, name, created_by)
         VALUES ($1, $2, $3, $4);`,
        [id, workspaceId, name, owner],
      );
      for (const [position, title] of ['One', 'Two'].entries()) {
        await client.query(
          `INSERT INTO projects.qa_checklist_items (checklist_id, "position", title)
           VALUES ($1, $2, $3);`,
          [id, position, title],
        );
      }
      for (const project of shares) {
        await client.query(
          `INSERT INTO projects.qa_checklist_projects (checklist_id, project_id, shared_by)
           VALUES ($1, $2, $3);`,
          [id, project, owner],
        );
      }
    }

    for (const [checklist, project] of [
      [testChecklist, repoA1],
      [testChecklist, repoB1],
      [johnsChecklist, repoB1],
    ] as const) {
      await client.query(
        `INSERT INTO projects.qa_verification_runs
           (project_id, checklist_id, checklist_version, checklist_name, branch,
            commit_sha, commit_source, created_by, created_by_login)
         VALUES ($1, $2, 1, 'n', 'uat', $3, 'branch_head', $4, 'qa');`,
        [
          project,
          checklist,
          randomUUID().replace(/-/g, '').padEnd(40, '0'),
          owner,
        ],
      );
    }
  }

  async function requirementsFor(
    deliveryProjectId: string | null,
  ): Promise<Array<{ name: string; items: number; legacy: string | null }>> {
    const result = await client.query<{
      name: string;
      items: string;
      legacy_checklist_id: string | null;
    }>(
      `SELECT c.name, c.legacy_checklist_id,
              (SELECT COUNT(*) FROM projects.qa_checklist_items i WHERE i.checklist_id = c.id) AS items
         FROM projects.qa_checklists c
        WHERE c.delivery_project_id IS NOT DISTINCT FROM $1::uuid
          AND c.workspace_id = $2
        ORDER BY c.name;`,
      [deliveryProjectId, workspaceId],
    );
    return result.rows.map((row) => ({
      name: row.name,
      items: Number(row.items),
      legacy: row.legacy_checklist_id,
    }));
  }

  it('applies to the legacy data shape and backfills one requirement per Project', async () => {
    await applyFile(client, join('projects', MIGRATION));

    expect(await requirementsFor(projectA)).toEqual([
      { name: 'TestChecklist', items: 2, legacy: null },
    ]);
    expect(await requirementsFor(projectB)).toEqual([
      { name: "John's Password", items: 2, legacy: null },
      { name: 'TestChecklist', items: 2, legacy: testChecklist },
    ]);
    // Unshared, archived-Project and archived-repository checklists stay unassigned.
    expect((await requirementsFor(null)).map((row) => row.name).sort()).toEqual(
      ['Archived project', 'Archived repo', 'Loose'],
    );

    // The original keeps its id, so the three legacy runs stay linked to it.
    const runs = await client.query<{ scope: string; checklist_id: string }>(
      `SELECT scope, checklist_id FROM projects.qa_verification_runs;`,
    );
    expect(runs.rows).toHaveLength(3);
    expect(runs.rows.every((row) => row.scope === 'repository')).toBe(true);
    expect(
      runs.rows.filter((row) => row.checklist_id === testChecklist),
    ).toHaveLength(2);

    // The legacy share table is untouched.
    expect(
      await count(
        client,
        `SELECT COUNT(*) AS n FROM projects.qa_checklist_projects;`,
      ),
    ).toBe(5);
    expect(
      await count(
        client,
        `SELECT COUNT(*) AS n FROM projects.qa_checklist_items WHERE progress <> 'todo';`,
      ),
    ).toBe(0);
  });

  it('is idempotent: re-running the migration and the tree adds nothing', async () => {
    const before = await count(
      client,
      `SELECT COUNT(*) AS n FROM projects.qa_checklists;`,
    );
    const itemsBefore = await count(
      client,
      `SELECT COUNT(*) AS n FROM projects.qa_checklist_items;`,
    );

    // The QA migrations, in order: replaying the earlier ones after this one
    // must not recreate the old, stricter name index.
    for (const file of orderedFiles.filter(
      (f) => basename(f) >= FIRST_QA_MIGRATION,
    )) {
      await applyFile(client, file);
    }

    expect(
      await count(client, `SELECT COUNT(*) AS n FROM projects.qa_checklists;`),
    ).toBe(before);
    expect(
      await count(
        client,
        `SELECT COUNT(*) AS n FROM projects.qa_checklist_items;`,
      ),
    ).toBe(itemsBefore);
  });

  // The negative cases use the simple query protocol (no bind parameters): the
  // identifiers are generated UUIDs, and a failed extended-protocol statement
  // is what some Postgres wire emulators answer out of order.
  it('enforces name uniqueness per Project scope and kind', async () => {
    // Same name in another kind of the same scope is fine.
    await client.query(
      `INSERT INTO projects.qa_checklists (workspace_id, name, created_by, kind, delivery_project_id, iteration_id)
       VALUES ('${workspaceId}', 'TestChecklist', '${owner}', 'functional', '${projectA}',
               (SELECT id FROM projects.project_iterations WHERE delivery_project_id = '${projectA}' AND number = 1));`,
    );
    // The same name twice in the same scope and kind is not.
    await expect(
      client.query(
        `INSERT INTO projects.qa_checklists (workspace_id, name, created_by, kind, delivery_project_id, iteration_id)
         VALUES ('${workspaceId}', 'testchecklist', '${owner}', 'system', '${projectA}',
                 (SELECT id FROM projects.project_iterations WHERE delivery_project_id = '${projectA}' AND number = 1));`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a functional requirement with no Project', async () => {
    await expect(
      client.query(
        `INSERT INTO projects.qa_checklists (workspace_id, name, created_by, kind)
         VALUES ('${workspaceId}', 'Orphan feature', '${owner}', 'functional');`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects runs whose scope and shape disagree, and dedupes Project runs by fingerprint', async () => {
    const fingerprint = 'a'.repeat(64);
    const insertProjectRun = () =>
      client.query(
        `INSERT INTO projects.qa_verification_runs
           (scope, delivery_project_id, iteration_id, heads_fingerprint, checklist_version,
            checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('project', '${projectA}', (SELECT id FROM projects.project_iterations WHERE delivery_project_id = '${projectA}' AND number = 1), '${fingerprint}', 0, 'Project A', 'uat',
                 'branch_head', '${owner}', 'qa');`,
      );
    await insertProjectRun();
    await expect(insertProjectRun()).rejects.toMatchObject({ code: '23505' });

    // A repository-scope run must carry its repository and commit.
    await expect(
      client.query(
        `INSERT INTO projects.qa_verification_runs
           (scope, checklist_version, checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('repository', 1, 'x', 'uat', 'branch_head', '${owner}', 'qa');`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // A Project-scope run must not carry a repository.
    await expect(
      client.query(
        `INSERT INTO projects.qa_verification_runs
           (scope, project_id, delivery_project_id, iteration_id, heads_fingerprint, checklist_version,
            checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('project', '${repoA1}', '${projectB}', (SELECT id FROM projects.project_iterations WHERE delivery_project_id = '${projectB}' AND number = 1), '${'b'.repeat(64)}', 0, 'x', 'uat',
                 'branch_head', '${owner}', 'qa');`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------
  // 20261015010000_project_iterations.sql: Iteration 1 for every Project
  // -------------------------------------------------------------------

  describe('project_iterations', () => {
    const iterationOf = (project: string, number = 1) =>
      `(SELECT id FROM projects.project_iterations WHERE delivery_project_id = '${project}' AND number = ${number})`;
    const fingerprint = 'e'.repeat(64);
    const insertRun = (project: string, number: number) =>
      client.query(
        `INSERT INTO projects.qa_verification_runs
           (scope, delivery_project_id, iteration_id, heads_fingerprint, checklist_version,
            checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('project', '${project}', ${iterationOf(project, number)}, '${fingerprint}', 0,
                 'x', 'uat', 'branch_head', '${owner}', 'qa');`,
      );

    it('gives every Project, whatever its status, one active Iteration 1 started when the Project was created', async () => {
      const rows = await client.query<{
        delivery_project_id: string;
        number: number;
        status: string;
      }>(
        `SELECT delivery_project_id, number, status
           FROM projects.project_iterations ORDER BY started_at;`,
      );
      expect(
        rows.rows.map((row) => [
          row.delivery_project_id,
          row.number,
          row.status,
        ]),
      ).toEqual([
        [projectA, 1, 'active'],
        [projectB, 1, 'active'],
        [projectC, 1, 'active'],
      ]);
      // Started when the Project was created, not when the migration ran.
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.project_iterations i
             JOIN hierarchy.delivery_projects d ON d.id = i.delivery_project_id
            WHERE i.started_at <> d.created_at;`,
        ),
      ).toBe(0);
    });

    it('assigns every Project requirement to its Project Iteration; unassigned legacy checklists stay without one', async () => {
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.qa_checklists
            WHERE delivery_project_id IS NOT NULL AND iteration_id IS NULL;`,
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.qa_checklists c
             JOIN projects.project_iterations i ON i.id = c.iteration_id
            WHERE c.delivery_project_id <> i.delivery_project_id;`,
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.qa_checklists
            WHERE delivery_project_id IS NULL AND iteration_id IS NOT NULL;`,
        ),
      ).toBe(0);
    });

    it('re-running backfills Project rows that predate it and restores the presence CHECKs', async () => {
      await client.query(
        `ALTER TABLE projects.qa_checklists DROP CONSTRAINT qa_checklists_iteration_scope_chk;
         ALTER TABLE projects.qa_verification_runs DROP CONSTRAINT qa_verification_runs_iteration_scope_chk;`,
      );
      await client.query(
        `INSERT INTO projects.qa_checklists (workspace_id, name, created_by, kind, delivery_project_id)
         VALUES ('${workspaceId}', 'Predates iterations', '${owner}', 'system', '${projectC}');
         INSERT INTO projects.qa_verification_runs
           (scope, delivery_project_id, heads_fingerprint, checklist_version,
            checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('project', '${projectC}', '${'9'.repeat(64)}', 0, 'x', 'uat',
                 'branch_head', '${owner}', 'qa');`,
      );

      await applyFile(
        client,
        join('projects', '20261015010000_project_iterations.sql'),
      );

      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.qa_checklists c
             JOIN projects.project_iterations i ON i.id = c.iteration_id AND i.number = 1
            WHERE c.name = 'Predates iterations' AND i.delivery_project_id = '${projectC}';`,
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.qa_verification_runs
            WHERE scope = 'project' AND iteration_id IS NULL;`,
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.project_iterations;`,
        ),
      ).toBe(3);
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM pg_constraint
            WHERE conname IN ('qa_checklists_iteration_scope_chk', 'qa_verification_runs_iteration_scope_chk');`,
        ),
      ).toBe(2);
    });

    it('enforces presence with a CHECK, only where it applies', async () => {
      await expect(
        client.query(
          `INSERT INTO projects.qa_checklists (workspace_id, name, created_by, kind, delivery_project_id)
           VALUES ('${workspaceId}', 'No iteration', '${owner}', 'system', '${projectA}');`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `INSERT INTO projects.qa_verification_runs
             (scope, delivery_project_id, heads_fingerprint, checklist_version, checklist_name,
              branch, commit_source, created_by, created_by_login)
           VALUES ('project', '${projectA}', '${'8'.repeat(64)}', 0, 'x', 'uat',
                   'branch_head', '${owner}', 'qa');`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // An unassigned legacy system checklist has no Iteration and needs none.
      await client.query(
        `INSERT INTO projects.qa_checklists (workspace_id, name, created_by)
         VALUES ('${workspaceId}', 'Legacy without iteration', '${owner}');`,
      );
    });

    it('allows one active Iteration per Project, and a delivered one needs its date', async () => {
      await expect(
        client.query(
          `INSERT INTO projects.project_iterations (delivery_project_id, number)
           VALUES ('${projectA}', 2);`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        client.query(
          `UPDATE projects.project_iterations SET status = 'delivered'
            WHERE delivery_project_id = '${projectA}';`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `INSERT INTO projects.project_iterations (delivery_project_id, number, goal)
           VALUES ('${projectC}', 2, '${'g'.repeat(121)}');`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('swaps the keys: the same heads and the same requirement name are fine in the NEXT Iteration, not twice in one', async () => {
      await insertRun(projectA, 1);
      await expect(insertRun(projectA, 1)).rejects.toMatchObject({
        code: '23505',
      });

      await client.query(
        `UPDATE projects.project_iterations
            SET status = 'delivered', delivered_at = NOW()
          WHERE delivery_project_id = '${projectA}' AND number = 1;
         INSERT INTO projects.project_iterations (delivery_project_id, number)
         VALUES ('${projectA}', 2);`,
      );
      await insertRun(projectA, 2);
      await expect(insertRun(projectA, 2)).rejects.toMatchObject({
        code: '23505',
      });

      const insertRequirement = (number: number) =>
        client.query(
          `INSERT INTO projects.qa_checklists
             (workspace_id, name, created_by, kind, delivery_project_id, iteration_id)
           VALUES ('${workspaceId}', 'Carried over', '${owner}', 'functional', '${projectA}',
                   ${iterationOf(projectA, number)});`,
        );
      await insertRequirement(1);
      await insertRequirement(2);
      await expect(insertRequirement(2)).rejects.toMatchObject({
        code: '23505',
      });

      // The old keys are gone.
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM pg_indexes
            WHERE indexname IN ('uq_qa_runs_project_scope_heads', 'uq_qa_requirements_scope_name_active');`,
        ),
      ).toBe(0);
    });

    it('the repository resolves the current Iteration (active, else latest delivered) and creates Iteration 1 once', async () => {
      const iterations = new ProjectIterationsRepository(asDatabaseService());

      // Project A: Iteration 1 delivered, Iteration 2 active (set up above).
      expect((await iterations.findCurrent(projectA))?.number).toBe(2);
      expect(
        (await iterations.list(projectA)).map((row) => row.number),
      ).toEqual([2, 1]);
      const current = await iterations.findCurrentByDeliveryProjects([
        projectA,
        projectB,
      ]);
      expect(current.get(projectA)?.number).toBe(2);
      expect(current.get(projectB)?.number).toBe(1);

      // Between delivery and the next start, the latest delivered one is current.
      await client.query(
        `UPDATE projects.project_iterations
            SET status = 'delivered', delivered_at = NOW()
          WHERE delivery_project_id = '${projectA}' AND number = 2;`,
      );
      expect((await iterations.findCurrent(projectA))?.status).toBe(
        'delivered',
      );
      expect((await iterations.findCurrent(projectA))?.number).toBe(2);

      // Lazy creation: only for a Project with none, and exactly once.
      const fresh = randomUUID();
      await iterations.insertFirstIfNone([projectA, fresh]);
      await iterations.insertFirstIfNone([fresh]);
      expect(await iterations.list(projectA)).toHaveLength(2);
      const created = await iterations.list(fresh);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ number: 1, status: 'active' });

      // Leave Project A as the following tests expect it.
      await client.query(
        `UPDATE projects.project_iterations
            SET status = 'active', delivered_at = NULL
          WHERE delivery_project_id = '${projectA}' AND number = 2;`,
      );
    });
  });

  // -------------------------------------------------------------------
  // The repositories' own SQL, against the migrated schema (no mocks).
  // -------------------------------------------------------------------

  /** One pg client behaves as the app's DatabaseService: the repositories only call these three methods. */
  const asDatabaseService = (): DatabaseService => {
    const service = {
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
    };
    return service as unknown as DatabaseService;
  };

  describe('repositories', () => {
    const qa = { id: randomUUID(), login: 'qa' };
    const dev = { id: randomUUID(), login: 'dev' };
    let checklists: QaChecklistsRepository;
    let requirements: QaRequirementsRepository;
    let projectRuns: QaProjectRunsRepository;
    let runs: QaRunsRepository;
    let iterationB: string;
    let featureId: string;
    let storyA: string;
    let storyB: string;

    beforeAll(async () => {
      const db = asDatabaseService();
      checklists = new QaChecklistsRepository(db);
      requirements = new QaRequirementsRepository(db);
      projectRuns = new QaProjectRunsRepository(db);
      runs = new QaRunsRepository(db);
      const iteration = await client.query<{ id: string }>(
        `SELECT id FROM projects.project_iterations WHERE delivery_project_id = $1 AND number = 1;`,
        [projectB],
      );
      iterationB = iteration.rows[0]!.id;
      for (const user of [qa, dev]) {
        await client.query(
          `INSERT INTO identity.app_users (id, login) VALUES ('${user.id}', '${user.login}-${user.id.slice(0, 4)}');`,
        );
      }
    });

    it('creates a functional requirement with stories and lists functional first', async () => {
      const created = await checklists.createWithItems({
        workspaceId,
        name: 'Checkout feature',
        description: null,
        createdBy: owner,
        kind: 'functional',
        deliveryProjectId: projectB,
        iterationId: iterationB,
        items: [
          {
            title: 'Pay by card',
            acceptanceCriteria:
              'Given a cart, when I pay, then I get a receipt',
            targetPersona: 'all',
            verificationType: 'manual',
          },
          {
            title: 'Pay by wallet',
            targetPersona: 'all',
            verificationType: 'manual',
          },
        ],
      });
      featureId = created.checklist.id;
      [storyA, storyB] = created.items.map((item) => item.id) as [
        string,
        string,
      ];

      const listed = await checklists.listByIteration(iterationB, {
        includeArchived: false,
      });
      expect(listed[0]?.id).toBe(featureId);
      expect(created.items[0]).toMatchObject({
        acceptance_criteria: 'Given a cart, when I pay, then I get a receipt',
        progress: 'todo',
        row_version: 1,
      });
      expect(
        await checklists.hasActiveNameConflict(
          workspaceId,
          'checkout FEATURE',
          undefined,
          {
            iterationId: iterationB,
            kind: 'functional',
          },
        ),
      ).toBe(true);
      expect(
        await checklists.hasActiveNameConflict(workspaceId, 'Checkout feature'),
      ).toBe(false);
    });

    it('edits items by id without losing Progress, and Progress writes are not requirement changes', async () => {
      const set = await requirements.setProgress(
        featureId,
        storyA,
        1,
        'in_progress',
        dev,
      );
      expect(set).toMatchObject({
        progress: 'in_progress',
        row_version: 2,
        progress_by_login: 'dev',
      });
      // A stale row_version writes nothing.
      expect(
        await requirements.setProgress(featureId, storyA, 1, 'done', dev),
      ).toBeNull();

      // Read `since` from the database clock: updated_at is stamped by NOW()
      // there, and a host clock a few ms off makes this comparison flaky.
      const since = (
        await client.query<{ now: string }>(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now;`,
        )
      ).rows[0]!.now;
      await client.query(`SELECT pg_sleep(0.05);`);
      await requirements.setProgress(featureId, storyA, 2, 'done', dev);
      expect(
        await requirements.requirementsChangedSince(iterationB, since),
      ).toBe(false);

      const edited = await requirements.updateItemDefinition(
        featureId,
        storyA,
        3,
        {
          title: 'Pay by credit card',
          acceptanceCriteria: null,
        },
      );
      expect(edited).toMatchObject({
        title: 'Pay by credit card',
        acceptance_criteria: null,
        progress: 'done',
        row_version: 4,
      });
      expect(
        await requirements.requirementsChangedSince(iterationB, since),
      ).toBe(true);
      expect(
        await requirements.updateItemDefinition(featureId, storyA, 3, {
          title: 'x',
        }),
      ).toBeNull();
    });

    it('appends, reorders (exact set only) and deletes items', async () => {
      const appended = await requirements.appendItem(featureId, {
        title: 'Refund',
      });
      expect(appended.position).toBe(2);

      expect(await requirements.reorderItems(featureId, [storyB, storyA])).toBe(
        false,
      );
      expect(
        await requirements.reorderItems(featureId, [
          appended.id,
          storyB,
          storyA,
        ]),
      ).toBe(true);
      const order = await checklists.listItemsByChecklistIds([featureId]);
      expect(order.get(featureId)?.map((item) => item.id)).toEqual([
        appended.id,
        storyB,
        storyA,
      ]);

      expect(await requirements.deleteItem(featureId, appended.id)).toBe(true);
      expect(await requirements.deleteItem(featureId, appended.id)).toBe(false);
    });

    let runId: string;
    let itemId: string;

    it('creates a Project run idempotently per set of heads, with coverage and a global snapshot', async () => {
      const items = await checklists.listItemsByChecklistIds([featureId]);
      const snapshot = (items.get(featureId) ?? []).map((item, index) => ({
        sourceItemId: item.id,
        requirementId: featureId,
        requirementName: 'Checkout feature',
        requirementKind: 'functional' as const,
        position: index,
        title: item.title,
        description: null,
        verificationType: item.verification_type,
        testIdentifier: null,
        acceptanceCriteria: item.acceptance_criteria,
      }));
      const input = {
        deliveryProjectId: projectB,
        iterationId: iterationB,
        projectName: 'Project B',
        headsFingerprint: 'c'.repeat(64),
        repositories: [
          {
            projectId: repoB1,
            repoFullName: 'acme/b1',
            headSha: '1'.repeat(40),
          },
        ],
        createdBy: qa.id,
        createdByLogin: qa.login,
        items: snapshot,
      };

      const first = await projectRuns.createRun(input);
      const second = await projectRuns.createRun(input);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.run.id).toBe(first.run.id);
      expect(first.items).toHaveLength(2);
      expect(first.items[0]).toMatchObject({
        requirement_name: 'Checkout feature',
        requirement_kind: 'functional',
        target_persona: 'all',
      });
      expect(first.repositories).toEqual([
        expect.objectContaining({
          repo_full_name: 'acme/b1',
          head_sha: '1'.repeat(40),
        }),
      ]);
      expect(first.run).toMatchObject({
        scope: 'project',
        project_id: null,
        commit_sha: null,
      });

      // A run for different heads links each item to the same item in the previous run.
      const next = await projectRuns.createRun({
        ...input,
        headsFingerprint: 'd'.repeat(64),
        repositories: [
          {
            projectId: repoB1,
            repoFullName: 'acme/b1',
            headSha: '2'.repeat(40),
          },
        ],
      });
      expect(next.created).toBe(true);
      expect(next.items.map((item) => item.prior_run_item_id).sort()).toEqual(
        first.items.map((item) => item.id).sort(),
      );
      runId = next.run.id;
      itemId = next.items.find((item) => item.source_item_id === storyB)!.id;
    });

    it('refuses to pass an item until its source Progress is done; returning it sends Progress back to in_progress, in one transaction', async () => {
      const rules = {
        requireProgressDoneForPass: true,
        resetProgressOnReturn: true,
      };
      const patch = (status: 'passed' | 'returned_to_dev') => ({
        status,
        notes: undefined,
        defectSeverity:
          status === 'returned_to_dev' ? ('major' as const) : undefined,
        reproductionSteps: undefined,
      });

      // storyB is still 'todo'.
      await expect(
        runs.updateItem(
          runId,
          itemId,
          1,
          patch('passed'),
          qa,
          'pending',
          rules,
        ),
      ).rejects.toBeInstanceOf(QaProgressNotDoneError);
      expect((await runs.findItemForRun(runId, itemId))?.status).toBe(
        'pending',
      );

      await requirements.setProgress(featureId, storyB, 1, 'done', dev);
      const passed = await runs.updateItem(
        runId,
        itemId,
        1,
        patch('passed'),
        qa,
        'pending',
        rules,
      );
      expect(passed).toMatchObject({
        status: 'passed',
        verified_by_login: 'qa',
      });

      const returned = await runs.updateItem(
        runId,
        itemId,
        passed!.row_version,
        patch('returned_to_dev'),
        qa,
        'passed',
        rules,
      );
      expect(returned?.status).toBe('returned_to_dev');
      const source = await requirements.findItem(featureId, storyB);
      expect(source?.progress).toBe('in_progress');

      // The developer finishing again re-queues the returned run item.
      const open = await projectRuns.findReturnedOpenRunItems(
        iterationB,
        storyB,
      );
      expect(open.map((row) => row.id)).toEqual([itemId]);
      const reset = await runs.requestRetest(runId, itemId, dev, 'fixed');
      expect(reset).toMatchObject({ status: 'pending', fix_note: 'fixed' });
      expect(
        await projectRuns.findReturnedOpenRunItems(iterationB, storyB),
      ).toEqual([]);
    });

    it('the latest signed-off Project run is the one with the newest active sign-off; reopening drops it', async () => {
      expect(await projectRuns.findLatestSignedOff(iterationB)).toBeNull();

      const items = await runs.listItemsByRunId(runId);
      const signedAt = new Date().toISOString();
      const result = await runs.createSignoff({
        id: randomUUID(),
        runId,
        verdict: 'REJECTED',
        summary: null,
        conditions: null,
        signedBy: qa.id,
        signedByLogin: qa.login,
        signedAt,
        reportJson: {},
        expectedItems: {
          count: items.length,
          rowVersionSum: items.reduce((sum, item) => sum + item.row_version, 0),
        },
      });
      expect(result?.run.status).toBe('signed_off');

      const latest = await projectRuns.findLatestSignedOff(iterationB);
      expect(latest?.run.id).toBe(runId);
      expect(latest?.signoff.verdict).toBe('REJECTED');
      expect(latest?.repositories.map((row) => row.head_sha)).toEqual([
        '2'.repeat(40),
      ]);

      await runs.reopenRun(runId, dev);
      expect(await projectRuns.findLatestSignedOff(iterationB)).toBeNull();

      const counts = await projectRuns.verificationCountsByRequirement(runId);
      expect(counts.get(featureId)).toEqual({
        pending: 2,
        passed: 0,
        failed: 0,
        blocked: 0,
        returned_to_dev: 0,
      });
    });

    it('purges a Project requirements but never unassigned ones', async () => {
      const before = await count(
        client,
        `SELECT COUNT(*) AS n FROM projects.qa_checklists WHERE delivery_project_id IS NULL;`,
      );
      expect(
        await checklists.deleteByDeliveryProject(projectB),
      ).toBeGreaterThan(0);
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.qa_checklists WHERE delivery_project_id IS NULL;`,
        ),
      ).toBe(before);
      // Runs keep their history; their requirement links are cleared.
      const kept = await client.query<{ requirement_id: string | null }>(
        `SELECT requirement_id FROM projects.qa_run_items WHERE run_id = '${runId}';`,
      );
      expect(kept.rows.length).toBeGreaterThan(0);
      expect(kept.rows.every((row) => row.requirement_id === null)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Iterations phase 3: Start the next iteration, real SQL, no mocks.
  // -------------------------------------------------------------------

  describe('start the next iteration', () => {
    const projectD = randomUUID();
    const lead = { id: randomUUID(), login: 'lead' };
    let iterations: ProjectIterationsRepository;
    let checklists: QaChecklistsRepository;
    let iteration1: string;
    let runId: string;
    let featureId: string;
    let systemId: string;
    let items: Record<string, string> = {};

    const one = async <T extends object>(sql: string): Promise<T> => {
      const result = await client.query<T>(sql);
      return result.rows[0] as T;
    };
    const sourceSnapshot = async () =>
      (
        await client.query<Record<string, unknown>>(
          `SELECT i.id, i.checklist_id, i."position", i.title, i.progress, i.progress_by,
                  i.progress_at, i.row_version, i.updated_at, c.iteration_id, c.updated_at AS c_updated
             FROM projects.qa_checklist_items i
             JOIN projects.qa_checklists c ON c.id = i.checklist_id
            WHERE c.iteration_id = '${iteration1}'
            ORDER BY i.id;`,
        )
      ).rows;

    beforeAll(async () => {
      const db = asDatabaseService();
      iterations = new ProjectIterationsRepository(db);
      checklists = new QaChecklistsRepository(db);
      const system = randomUUID();
      await client.query(
        `INSERT INTO hierarchy.systems (id, group_id, name) VALUES ($1, $2, 'D');`,
        [system, workspaceId],
      );
      await client.query(
        `INSERT INTO hierarchy.delivery_projects (id, system_id, group_id, name, status)
         VALUES ($1, $2, $3, 'Project D', 'active');`,
        [projectD, system, workspaceId],
      );
      await iterations.insertFirstIfNone([projectD]);
      iteration1 = (await iterations.findCurrent(projectD))!.id;

      const feature = await checklists.createWithItems({
        workspaceId,
        name: 'Checkout feature',
        description: 'Pay for a cart',
        createdBy: owner,
        kind: 'functional',
        deliveryProjectId: projectD,
        iterationId: iteration1,
        items: ['Pay by card', 'Pay by wallet', 'Pay by voucher'].map(
          (title) => ({
            title,
            acceptanceCriteria: `Given ${title}`,
            targetPersona: 'all' as const,
            verificationType: 'manual' as const,
            testIdentifier: `t-${title}`,
          }),
        ),
      });
      const system1 = await checklists.createWithItems({
        workspaceId,
        name: 'Hardening',
        description: null,
        createdBy: owner,
        kind: 'system',
        deliveryProjectId: projectD,
        iterationId: iteration1,
        items: [
          {
            title: 'Rate limit',
            targetPersona: 'all' as const,
            verificationType: 'manual' as const,
          },
        ],
      });
      featureId = feature.checklist.id;
      systemId = system1.checklist.id;
      items = {
        card: feature.items[0]!.id,
        wallet: feature.items[1]!.id,
        voucher: feature.items[2]!.id,
        rate: system1.items[0]!.id,
      };
      // Progress: card done+passed, wallet done+failed, voucher todo (not in
      // the run), rate-limit done+blocked.
      await client.query(
        `UPDATE projects.qa_checklist_items
            SET progress = 'done', progress_by = $2, progress_by_login = 'dev', progress_at = NOW()
          WHERE id = ANY($1::uuid[]);`,
        [[items.card, items.wallet, items.rate], lead.id],
      );

      runId = (
        await one<{ id: string }>(
          `INSERT INTO projects.qa_verification_runs
             (scope, delivery_project_id, iteration_id, heads_fingerprint, checklist_version,
              checklist_name, branch, commit_source, created_by, created_by_login)
           VALUES ('project', '${projectD}', '${iteration1}', '${'d'.repeat(64)}', 0,
                   'x', 'uat', 'branch_head', '${owner}', 'qa')
           RETURNING id;`,
        )
      ).id;
      const runItem = (
        position: number,
        source: string,
        title: string,
        status: string,
      ) =>
        client.query(
          `INSERT INTO projects.qa_run_items
             (run_id, source_item_id, "position", title, target_persona, verification_type,
              status, defect_severity, verified_by, verified_by_login, verified_at)
           VALUES ($1, $2, $3, $4, 'all', 'manual', $5,
                   CASE WHEN $5 = 'failed' THEN 'major' END,
                   CASE WHEN $5 = 'pending' THEN NULL ELSE $6::uuid END,
                   CASE WHEN $5 = 'pending' THEN NULL ELSE 'qa' END,
                   CASE WHEN $5 = 'pending' THEN NULL ELSE NOW() END);`,
          [runId, source, position, title, status, lead.id],
        );
      await runItem(0, items.card!, 'Pay by card', 'passed');
      await runItem(1, items.wallet!, 'Pay by wallet', 'failed');
      await runItem(2, items.rate!, 'Rate limit', 'blocked');
      await client.query(
        `UPDATE projects.project_iterations
            SET status = 'delivered', delivered_at = NOW(), signoff_run_id = '${runId}'
          WHERE id = '${iteration1}';`,
      );
    }, 60_000);

    it('lists the delivered items with the delivering run status', async () => {
      const rows = await iterations.listCarryOverItems(iteration1, runId);
      expect(
        rows.map((row) => [row.title, row.progress, row.last_status]),
      ).toEqual([
        ['Pay by card', 'done', 'passed'],
        ['Pay by wallet', 'done', 'failed'],
        ['Pay by voucher', 'todo', null],
        ['Rate limit', 'done', 'blocked'],
      ]);
    });

    it('creates Iteration 2 and copies the selected items; failed/blocked go back to in_progress, delivered rows stay frozen', async () => {
      const before = await sourceSnapshot();

      const result = await iterations.startNext({
        deliveryProjectId: projectD,
        startedBy: lead.id,
        startedByLogin: lead.login,
        goal: 'Loyalty points',
        // Out of source order on purpose: order follows the source position.
        itemIds: [items.rate!, items.voucher!, items.wallet!, items.card!],
        signoffRunId: runId,
      });

      expect(result).toMatchObject({
        iteration: {
          number: 2,
          status: 'active',
          goal: 'Loyalty points',
          started_by: lead.id,
          started_by_login: 'lead',
        },
        carriedRequirements: 2,
        carriedItems: 4,
      });
      const iteration2 = result.iteration.id;

      const requirements = await client.query<{
        name: string;
        kind: string;
        description: string | null;
        delivery_project_id: string;
        archived_at: string | null;
        created_by: string;
        id: string;
      }>(
        `SELECT * FROM projects.qa_checklists WHERE iteration_id = '${iteration2}'
          ORDER BY (kind = 'functional') DESC, created_at, id;`,
      );
      // The same names are allowed again in the new Iteration.
      expect(
        requirements.rows.map((row) => [row.name, row.kind, row.description]),
      ).toEqual([
        ['Checkout feature', 'functional', 'Pay for a cart'],
        ['Hardening', 'system', null],
      ]);
      expect(
        requirements.rows.every(
          (row) =>
            row.delivery_project_id === projectD &&
            row.archived_at === null &&
            row.created_by === owner &&
            row.id !== featureId &&
            row.id !== systemId,
        ),
      ).toBe(true);

      const copied = await client.query<{
        title: string;
        position: number;
        progress: string;
        progress_by: string | null;
        acceptance_criteria: string | null;
        test_identifier: string | null;
        requirement: string;
      }>(
        `SELECT i.title, i."position", i.progress, i.progress_by, i.acceptance_criteria,
                i.test_identifier, c.name AS requirement
           FROM projects.qa_checklist_items i
           JOIN projects.qa_checklists c ON c.id = i.checklist_id
          WHERE c.iteration_id = '${iteration2}'
          ORDER BY (c.kind = 'functional') DESC, c.created_at, i."position";`,
      );
      expect(
        copied.rows.map((row) => [
          row.requirement,
          row.position,
          row.title,
          row.progress,
          row.progress_by === null ? null : 'kept',
        ]),
      ).toEqual([
        // card passed: progress copied unchanged (with its author)
        ['Checkout feature', 0, 'Pay by card', 'done', 'kept'],
        // wallet failed: back to in_progress, no author
        ['Checkout feature', 1, 'Pay by wallet', 'in_progress', null],
        // voucher was not in the run: progress copied unchanged
        ['Checkout feature', 2, 'Pay by voucher', 'todo', null],
        // rate limit blocked: back to in_progress
        ['Hardening', 0, 'Rate limit', 'in_progress', null],
      ]);
      expect(copied.rows[0]).toMatchObject({
        acceptance_criteria: 'Given Pay by card',
        test_identifier: 't-Pay by card',
      });

      // Delivered rows are never modified.
      expect(await sourceSnapshot()).toEqual(before);
      expect((await iterations.findById(iteration1))?.status).toBe('delivered');
    });

    it('a second start loses to the one-active index (409 in the service) and writes nothing', async () => {
      const requirementsBefore = await count(
        client,
        `SELECT COUNT(*) AS n FROM projects.qa_checklists WHERE delivery_project_id = '${projectD}';`,
      );

      await expect(
        iterations.startNext({
          deliveryProjectId: projectD,
          startedBy: lead.id,
          startedByLogin: lead.login,
          goal: null,
          itemIds: [items.card!],
          signoffRunId: runId,
        }),
      ).rejects.toMatchObject({ code: '23505' });

      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.project_iterations WHERE delivery_project_id = '${projectD}';`,
        ),
      ).toBe(2);
      expect(
        await count(
          client,
          `SELECT COUNT(*) AS n FROM projects.qa_checklists WHERE delivery_project_id = '${projectD}';`,
        ),
      ).toBe(requirementsBefore);
    });

    it('a new QA run starts in Iteration 2 on unchanged heads', async () => {
      const iteration2 = (await iterations.findCurrent(projectD))!.id;
      await expect(
        client.query(
          `INSERT INTO projects.qa_verification_runs
             (scope, delivery_project_id, iteration_id, heads_fingerprint, checklist_version,
              checklist_name, branch, commit_source, created_by, created_by_login)
           VALUES ('project', '${projectD}', '${iteration2}', '${'d'.repeat(64)}', 0,
                   'x', 'uat', 'branch_head', '${owner}', 'qa');`,
        ),
      ).resolves.toBeDefined();
    });

    it('a start with nothing selected creates an empty Iteration', async () => {
      await client.query(
        `UPDATE projects.project_iterations
            SET status = 'delivered', delivered_at = NOW()
          WHERE delivery_project_id = '${projectD}' AND number = 2;`,
      );
      const result = await iterations.startNext({
        deliveryProjectId: projectD,
        startedBy: lead.id,
        startedByLogin: lead.login,
        goal: null,
        itemIds: [],
        signoffRunId: null,
      });
      expect(result).toMatchObject({
        iteration: { number: 3, goal: null },
        carriedRequirements: 0,
        carriedItems: 0,
      });
    });
  });
});
