import { basename } from 'node:path';

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

const MIGRATION = '20260928100000_deployment_target_environments.sql';

/**
 * Attaching legacy targets to environments: only unambiguous targets are
 * attached, a rerun changes nothing, and the rollback restores the legacy
 * schema without losing targets.
 */
describe('Deployment target environments migration', () => {
  const adminUrl = process.env['E2E_ADMIN_DATABASE_URL'] ?? '';
  const name = uniqueDatabaseName('target_migration');
  let url: string;

  const all = migrationFiles();
  const migration = all.find((file) => basename(file) === MIGRATION);
  const before = all.filter((file) => basename(file) < MIGRATION);

  const run = <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ) =>
    withClient(
      url,
      async (client) => (await client.query<T>(sql, params)).rows,
    );

  async function project(
    ownerId: string,
    repo: string,
    environments: Array<{ slug: string; branch: string }>,
    targetBranches: string[],
  ): Promise<void> {
    const [row] = await run<{ id: string }>(
      `INSERT INTO projects.provisioned_projects
         (user_id, repo_full_name, template_id, service_name, workflow_path, status)
       VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
       RETURNING id`,
      [ownerId, repo],
    );
    const projectId = required(row).id;
    for (const [position, environment] of environments.entries()) {
      await run(
        `INSERT INTO projects.project_environments
           (project_id, slug, display_name, position, source_branch, role, auto_deploy)
         VALUES ($1, $2, $2, $3, $4, $5, $6)`,
        [
          projectId,
          environment.slug,
          position,
          environment.branch,
          position === 0 ? 'production' : 'non_production',
          position === 0,
        ],
      );
    }
    for (const [index, branch] of targetBranches.entries()) {
      await run(
        `INSERT INTO env_provisioning.project_deployment_targets
           (project_id, slot, ownership_mode, provider, provider_project_id,
            provider_project_name, repo_full_name, branch_name, deployment_strategy)
         VALUES ($1, 'backend', 'flowci_managed', 'render', $2, $2, $3, $4, 'render_git_connected')`,
        [projectId, repo + '-' + String(index), repo, branch],
      );
    }
  }

  async function attachments() {
    return run<{ repo: string; environment: string | null }>(
      `SELECT target.repo_full_name AS repo, environment.slug AS environment
         FROM env_provisioning.project_deployment_targets AS target
         LEFT JOIN projects.project_environments AS environment
           ON environment.id = target.environment_id
        ORDER BY target.repo_full_name, target.provider_project_id`,
    );
  }

  const expected = [
    { repo: 'e2e/env-without-matching-target', environment: null },
    { repo: 'e2e/one-environment-one-target', environment: 'main' },
    { repo: 'e2e/two-environments-one-branch', environment: null },
    { repo: 'e2e/two-targets-one-branch', environment: null },
    { repo: 'e2e/two-targets-one-branch', environment: null },
  ];

  beforeAll(async () => {
    if (!migration) throw new Error(MIGRATION + ' is missing');
    url = await createDatabase(adminUrl, name);
    await applySqlFiles(url, before);
    const [owner] = await run<{ id: string }>(
      "INSERT INTO identity.app_users (login, github_user_id) VALUES ('e2e-owner', 'e2e-owner') RETURNING id",
    );
    const ownerId = required(owner).id;
    await project(
      ownerId,
      'e2e/one-environment-one-target',
      [{ slug: 'main', branch: 'main' }],
      ['main'],
    );
    await project(
      ownerId,
      'e2e/two-environments-one-branch',
      [
        { slug: 'main', branch: 'main' },
        { slug: 'qa', branch: 'main' },
      ],
      ['main'],
    );
    await project(
      ownerId,
      'e2e/two-targets-one-branch',
      [{ slug: 'main', branch: 'main' }],
      ['main', 'main'],
    );
    await project(
      ownerId,
      'e2e/env-without-matching-target',
      [{ slug: 'main', branch: 'main' }],
      ['uat'],
    );
  });

  afterAll(async () => {
    await dropDatabase(adminUrl, name);
  });

  it('attaches only a target whose environment is unambiguous', async () => {
    await applySqlFiles(url, [migration!]);
    expect(await attachments()).toEqual(expected);
  });

  it('can be applied again without changing attachments', async () => {
    await applySqlFiles(url, [migration!]);
    expect(await attachments()).toEqual(expected);
  });

  it('rolls back to branch-only targets and keeps every target', async () => {
    await applySqlFiles(url, [rollbackFile(MIGRATION)]);
    const [column] = await run<{ count: string }>(
      `SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'env_provisioning'
          AND table_name = 'project_deployment_targets'
          AND column_name = 'environment_id'`,
    );
    expect(required(column).count).toBe('0');
    const [targets] = await run<{ count: string }>(
      'SELECT count(*) FROM env_provisioning.project_deployment_targets',
    );
    expect(required(targets).count).toBe('5');
  });

  it('restores the same attachments when reapplied after rollback', async () => {
    await applySqlFiles(url, [migration!]);
    expect(await attachments()).toEqual(expected);
  });
});
