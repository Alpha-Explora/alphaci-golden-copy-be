import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

import type { DatabaseService } from '../../src/kernel/db/database.service';
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
      `INSERT INTO projects.qa_checklists (workspace_id, name, created_by, kind, delivery_project_id)
       VALUES ('${workspaceId}', 'TestChecklist', '${owner}', 'functional', '${projectA}');`,
    );
    // The same name twice in the same scope and kind is not.
    await expect(
      client.query(
        `INSERT INTO projects.qa_checklists (workspace_id, name, created_by, kind, delivery_project_id)
         VALUES ('${workspaceId}', 'testchecklist', '${owner}', 'system', '${projectA}');`,
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
           (scope, delivery_project_id, heads_fingerprint, checklist_version,
            checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('project', '${projectA}', '${fingerprint}', 0, 'Project A', 'uat',
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
           (scope, project_id, delivery_project_id, heads_fingerprint, checklist_version,
            checklist_name, branch, commit_source, created_by, created_by_login)
         VALUES ('project', '${repoA1}', '${projectB}', '${'b'.repeat(64)}', 0, 'x', 'uat',
                 'branch_head', '${owner}', 'qa');`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
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
    let featureId: string;
    let storyA: string;
    let storyB: string;

    beforeAll(async () => {
      const db = asDatabaseService();
      checklists = new QaChecklistsRepository(db);
      requirements = new QaRequirementsRepository(db);
      projectRuns = new QaProjectRunsRepository(db);
      runs = new QaRunsRepository(db);
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

      const listed = await checklists.listByDeliveryProject(projectB, {
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
            deliveryProjectId: projectB,
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

      const since = new Date().toISOString();
      await client.query(`SELECT pg_sleep(0.05);`);
      await requirements.setProgress(featureId, storyA, 2, 'done', dev);
      expect(await requirements.requirementsChangedSince(projectB, since)).toBe(
        false,
      );

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
      expect(await requirements.requirementsChangedSince(projectB, since)).toBe(
        true,
      );
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
      const open = await projectRuns.findReturnedOpenRunItems(projectB, storyB);
      expect(open.map((row) => row.id)).toEqual([itemId]);
      const reset = await runs.requestRetest(runId, itemId, dev, 'fixed');
      expect(reset).toMatchObject({ status: 'pending', fix_note: 'fixed' });
      expect(
        await projectRuns.findReturnedOpenRunItems(projectB, storyB),
      ).toEqual([]);
    });

    it('the latest signed-off Project run is the one with the newest active sign-off; reopening drops it', async () => {
      expect(await projectRuns.findLatestSignedOff(projectB)).toBeNull();

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

      const latest = await projectRuns.findLatestSignedOff(projectB);
      expect(latest?.run.id).toBe(runId);
      expect(latest?.signoff.verdict).toBe('REJECTED');
      expect(latest?.repositories.map((row) => row.head_sha)).toEqual([
        '2'.repeat(40),
      ]);

      await runs.reopenRun(runId, dev);
      expect(await projectRuns.findLatestSignedOff(projectB)).toBeNull();

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
});
