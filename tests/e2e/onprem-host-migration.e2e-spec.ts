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

const MIGRATION = '20261015010000_one_active_onprem_host.sql';

describe('One active on-prem host migration', () => {
  const adminUrl = process.env['E2E_ADMIN_DATABASE_URL'] ?? '';
  const name = uniqueDatabaseName('host_migration');
  const all = migrationFiles();
  const migration = required(all.find((file) => basename(file) === MIGRATION));
  let url: string;
  let environmentId: string;

  beforeAll(async () => {
    url = await createDatabase(adminUrl, name);
    await applySqlFiles(
      url,
      all.filter((file) => basename(file) < MIGRATION),
    );
    await withClient(url, async (client) => {
      const owner = await client.query<{ id: string }>(
        "INSERT INTO identity.app_users (login, github_user_id) VALUES ('host-owner', 'host-owner') RETURNING id",
      );
      const project = await client.query<{ id: string }>(
        `INSERT INTO projects.provisioned_projects
           (user_id, repo_full_name, template_id, service_name, workflow_path, status)
         VALUES ($1, 'e2e/hosts', 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned') RETURNING id`,
        [required(owner.rows[0]).id],
      );
      const projectId = required(project.rows[0]).id;
      for (const [position, slug] of ['test', 'main'].entries()) {
        const environment = await client.query<{ id: string }>(
          `INSERT INTO projects.project_environments
             (project_id, slug, display_name, position, source_branch, role, auto_deploy)
           VALUES ($1, $2, $2, $3, $2, $4, $5) RETURNING id`,
          [
            projectId,
            slug,
            position,
            position === 0 ? 'non_production' : 'production',
            position === 0,
          ],
        );
        const id = required(environment.rows[0]).id;
        if (position === 0) environmentId = id;
        for (const [index, label] of ['old', 'current', 'revoked'].entries()) {
          await client.query(
            `INSERT INTO env_provisioning.onprem_hosts
               (project_id, environment_id, name, token_prefix, token_sha256, created_at, revoked_at)
             VALUES ($1, $2, $3, 'test', $4, $5, $6)`,
            [
              projectId,
              id,
              slug + '-' + label,
              String(position * 3 + index).repeat(64),
              '2026-10-' + String(10 + index) + 'T00:00:00Z',
              label === 'revoked' ? '2026-10-14T00:00:00Z' : null,
            ],
          );
        }
      }
    });
  });

  afterAll(async () => {
    await dropDatabase(adminUrl, name);
  });

  it('keeps the newest active host per environment and never reactivates revoked tokens on rollback', async () => {
    const active = () =>
      withClient(url, async (client) =>
        (
          await client.query<{ name: string }>(
            'SELECT name FROM env_provisioning.onprem_hosts WHERE revoked_at IS NULL ORDER BY name',
          )
        ).rows.map(({ name }) => name),
      );
    expect(await active()).toEqual([
      'main-current',
      'main-old',
      'test-current',
      'test-old',
    ]);
    await applySqlFiles(url, [migration]);
    expect(await active()).toEqual(['main-current', 'test-current']);
    await applySqlFiles(url, [migration]);
    expect(await active()).toEqual(['main-current', 'test-current']);
    await expect(
      withClient(url, (client) =>
        client.query(
          `INSERT INTO env_provisioning.onprem_hosts
         (project_id, environment_id, name, token_prefix, token_sha256)
       SELECT project_id, environment_id, 'duplicate', 'test', repeat('f', 64)
         FROM env_provisioning.onprem_hosts WHERE environment_id = $1 LIMIT 1`,
          [environmentId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await applySqlFiles(url, [rollbackFile(MIGRATION)]);
    expect(await active()).toEqual(['main-current', 'test-current']);
    await applySqlFiles(url, [migration]);
    expect(await active()).toEqual(['main-current', 'test-current']);
  });
});
