import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../src/kernel/db/database.service';
import { ReleaseRegistryRepository } from '../../src/modules/runtime/infrastructure/repositories/release-registry.repository';
import { DeploymentTargetsRepository } from '../../src/modules/runtime/infrastructure/repositories/deployment-targets.repository';
import { required, withClient } from './support/database';

describe('On-prem registry history isolation', () => {
  it('filters project, environment, target membership, and preserves failed rollback identity', async () => {
    await withClient(
      process.env['E2E_APP_DATABASE_URL'] ?? '',
      async (client) => {
        await client.query('BEGIN');
        try {
          const db = {
            query: client.query.bind(client),
          } as unknown as DatabaseService;
          const targets = new DeploymentTargetsRepository(db);
          const releases = new ReleaseRegistryRepository(db);
          const owner = required(
            (
              await client.query<{ id: string }>(
                'INSERT INTO identity.app_users (login, github_user_id) VALUES ($1, $1) RETURNING id',
                [randomUUID()],
              )
            ).rows[0],
          ).id;
          const projects: string[] = [];
          const environments: string[] = [];
          for (let i = 0; i < 2; i++) {
            const projectId = required(
              (
                await client.query<{ id: string }>(
                  `INSERT INTO projects.provisioned_projects (user_id, repo_full_name, template_id, service_name, workflow_path, status)
             VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned') RETURNING id`,
                  [owner, 'e2e/' + randomUUID()],
                )
              ).rows[0],
            ).id;
            projects.push(projectId);
            environments.push(
              required(
                (
                  await client.query<{ id: string }>(
                    `INSERT INTO projects.project_environments (project_id, slug, display_name, position, source_branch, role, auto_deploy)
             VALUES ($1, 'dev', 'Test', 0, 'dev', 'non_production', true) RETURNING id`,
                    [projectId],
                  )
                ).rows[0],
              ).id,
            );
          }
          const projectId = required(projects[0]);
          const environmentId = required(environments[0]);
          const createTarget = (
            name: string,
            env: string | null = environmentId,
          ) =>
            targets.createDeploymentTarget({
              projectId,
              environmentId: env,
              slot: name === 'other' ? 'backend' : 'frontend',
              ownershipMode: 'byo',
              provider: 'onprem-compose',
              providerProjectId: name,
              providerProjectName: name,
              repoFullName: 'e2e/history',
              branchName: name,
              deploymentStrategy: 'provider_native',
            });
          const target = await createTarget('tracked');
          const other = await createTarget('other');
          const unbound = await createTarget('unbound', null);
          const releaseId = required(
            (
              await client.query<{ id: string }>(
                `INSERT INTO env_provisioning.releases (project_id, source_environment_id, source_branch, commit_sha,
           workflow_provider, workflow_repo, workflow_run_id, workflow_run_url)
           VALUES ($1, $2, 'dev', $3, 'github_actions', 'e2e/history', '1', 'https://github.com/e2e/history/actions/runs/1') RETURNING id`,
                [projectId, environmentId, 'a'.repeat(40)],
              )
            ).rows[0],
          ).id;
          await client.query(
            `INSERT INTO env_provisioning.environment_deployments (project_id, environment_id, release_id, trigger, target_ids, delivery, status)
           VALUES ($1, $2, $3, 'automatic', $4::uuid[], 'host', 'rolled_back'),
                  ($1, $5, $3, 'promotion', $4::uuid[], 'host', 'healthy')`,
            [
              projectId,
              environmentId,
              releaseId,
              [target.id],
              required(environments[1]),
            ],
          );
          const history = await releases.listTargetDeploymentHistory(
            projectId,
            target.id,
          );
          expect(history).toHaveLength(1);
          expect(history[0]).toMatchObject({
            targetId: target.id,
            commitSha: 'a'.repeat(40),
            status: 'failed',
            readyAt: null,
          });
          expect(
            await releases.listTargetDeploymentHistory(
              required(projects[1]),
              target.id,
            ),
          ).toEqual([]);
          expect(
            await releases.listTargetDeploymentHistory(projectId, other.id),
          ).toEqual([]);
          expect(
            await releases.listTargetDeploymentHistory(projectId, unbound.id),
          ).toEqual([]);
        } finally {
          await client.query('ROLLBACK');
        }
      },
    );
  });
});
