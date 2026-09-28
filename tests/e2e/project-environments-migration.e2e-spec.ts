import {
  applySqlFiles,
  createDatabase,
  dropDatabase,
  migrationFiles,
  required,
  rollbackFile,
  uniqueDatabaseName,
  withClient,
} from './support/database';

const MIGRATION = '20260925050000_project_environments.sql';

type Environment = {
  repo: string;
  slug: string;
  source_branch: string;
  role: string;
  position: number;
  auto_deploy: boolean;
};

/**
 * The project-environments migration against a database holding legacy
 * projects: it backfills only unambiguous projects, reruns safely, and its
 * rollback removes the table without touching projects.
 */
describe('Project environments migration', () => {
  const adminUrl = process.env['E2E_ADMIN_DATABASE_URL'] ?? '';
  const name = uniqueDatabaseName('migration');
  let url: string;

  const all = migrationFiles();
  const migration = all.find((file) => file.endsWith(MIGRATION));
  const before = all.filter((file) => file.split(/[\\/]/).pop()! < MIGRATION);

  const run = <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ) =>
    withClient(
      url,
      async (client) => (await client.query<T>(sql, params)).rows,
    );

  async function environments(): Promise<Environment[]> {
    return run<Environment>(
      `SELECT project.repo_full_name AS repo, environment.slug,
              environment.source_branch, environment.role,
              environment.position, environment.auto_deploy
         FROM projects.project_environments AS environment
         JOIN projects.provisioned_projects AS project ON project.id = environment.project_id
        ORDER BY project.repo_full_name, environment.position`,
    );
  }

  async function legacyProject(
    ownerId: string,
    repo: string,
    targets: Array<{
      provider: 'render' | 'vercel';
      branch: string;
      renderEnvironment: string | null;
    }>,
  ): Promise<void> {
    const [project] = await run<{ id: string }>(
      `INSERT INTO projects.provisioned_projects
         (user_id, repo_full_name, template_id, service_name, workflow_path, status)
       VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
       RETURNING id`,
      [ownerId, repo],
    );
    for (const [index, target] of targets.entries()) {
      await run(
        `INSERT INTO env_provisioning.project_deployment_targets
           (project_id, slot, ownership_mode, provider, provider_project_id,
            provider_project_name, repo_full_name, branch_name,
            deployment_strategy, render_environment_name)
         VALUES ($1, 'backend', 'flowci_managed', $2, $3, $3, $4, $5, $6, $7)`,
        [
          required(project).id,
          target.provider,
          repo + '-' + String(index),
          repo,
          target.branch,
          target.provider === 'render'
            ? 'render_git_connected'
            : 'vercel_git_connected',
          target.renderEnvironment,
        ],
      );
    }
  }

  beforeAll(async () => {
    if (!migration) throw new Error(MIGRATION + ' is missing');
    url = await createDatabase(adminUrl, name);
    await applySqlFiles(url, before);

    const [owner] = await run<{ id: string }>(
      "INSERT INTO identity.app_users (login, github_user_id) VALUES ('e2e-owner', 'e2e-owner') RETURNING id",
    );
    const ownerId = required(owner).id;
    await legacyProject(ownerId, 'e2e/explicit-production', [
      {
        provider: 'render',
        branch: 'release',
        renderEnvironment: 'production',
      },
    ]);
    await legacyProject(ownerId, 'e2e/branch-named-main', [
      { provider: 'render', branch: 'main', renderEnvironment: 'production' },
    ]);
    await legacyProject(ownerId, 'e2e/two-branches', [
      {
        provider: 'render',
        branch: 'release',
        renderEnvironment: 'production',
      },
      { provider: 'render', branch: 'uat', renderEnvironment: 'uat' },
    ]);
    await legacyProject(ownerId, 'e2e/vercel-only', [
      { provider: 'vercel', branch: 'release', renderEnvironment: null },
    ]);
    await legacyProject(ownerId, 'e2e/no-targets', []);
  });

  afterAll(async () => {
    await dropDatabase(adminUrl, name);
  });

  const expected: Environment[] = [
    {
      repo: 'e2e/explicit-production',
      slug: 'release',
      source_branch: 'release',
      role: 'production',
      position: 0,
      auto_deploy: true,
    },
  ];

  it('backfills only the project with one explicit production target', async () => {
    await applySqlFiles(url, [migration!]);
    expect(await environments()).toEqual(expected);
  });

  it('can be applied again without duplicating environments', async () => {
    await applySqlFiles(url, [migration!]);
    expect(await environments()).toEqual(expected);
  });

  it('rolls back to the legacy schema and keeps every project', async () => {
    await applySqlFiles(url, [rollbackFile(MIGRATION)]);

    const [table] = await run<{ exists: boolean }>(
      "SELECT to_regclass('projects.project_environments') IS NOT NULL AS exists",
    );
    expect(required(table).exists).toBe(false);
    const [projects] = await run<{ count: string }>(
      'SELECT count(*) FROM projects.provisioned_projects',
    );
    expect(required(projects).count).toBe('5');
  });

  it('restores the same backfill when reapplied after rollback', async () => {
    await applySqlFiles(url, [migration!]);
    expect(await environments()).toEqual(expected);
  });
});
