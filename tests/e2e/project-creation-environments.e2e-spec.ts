import yaml from 'js-yaml';

import {
  startApplication,
  type E2eApplication,
  type SignedInAgent,
} from './support/application';
import { required } from './support/database';

type Job = { if?: string; uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, Job> };

/**
 * Creating a single-repository project with its own ordered environments,
 * through the real provisioning path with GitHub, the CI token issuer, and
 * provider clients faked at their ports. Failure modes: environments stored
 * out of order or not at all; a shared branch created twice; the first
 * environment's branch protected or a later one left unprotected; environments
 * sharing a target or GitHub Environment; the pipeline pushed to a branch it
 * does not run on, deploying a later environment on push, or naming a target
 * of another environment.
 */
describe('Project creation with environments', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let workspaceId: string;
  let commits = 0;
  const installationToken = () => Promise.resolve('e2e-installation-token');

  beforeAll(async () => {
    e2e = await startApplication({
      githubAnswers: {
        getInstallationAccessTokenForUser: installationToken,
        getInstallationAccessTokenForUserRepo: installationToken,
        getOrganizationProvisioningContextByLogin: () =>
          Promise.resolve({
            login: 'e2e-org',
            installationId: 1,
            accessToken: 'e2e-installation-token',
          }),
        getOrganizationProvisioningContext: () =>
          Promise.resolve({
            login: 'e2e-org',
            installationId: 1,
            accessToken: 'e2e-installation-token',
          }),
        createRepo: (_token, options) =>
          Promise.resolve({
            repoUrl:
              'https://github.com/e2e-org/' +
              (options as { repoName: string }).repoName,
            ownerLogin: 'e2e-org',
            repoName: (options as { repoName: string }).repoName,
          }),
        putFileContent: () => {
          commits += 1;
          return Promise.resolve({
            commitSha: String(commits).padStart(40, 'a'),
            commitUrl: null,
          });
        },
        getFileContent: () => Promise.resolve(null),
        setActionsSecretStrict: () => Promise.resolve(),
        setActionsVariableStrict: () => Promise.resolve(),
        createBranch: () => Promise.resolve(),
        applyBranchProtection: () => Promise.resolve(),
      },
      ciAnswers: {
        issueProjectToken: () =>
          Promise.resolve({ token: 'e2e-ci-token', tokenPrefix: 'e2e-ci' }),
      },
    });
    const signedIn = await e2e.signIn();
    agent = signedIn.agent;
    // Creating repositories is a lead's or admin's action, inside a team.
    await e2e.query(
      "UPDATE identity.app_users SET app_role = 'lead' WHERE id = $1",
      [signedIn.userId],
    );
    const [workspace] = await e2e.query<{ id: string }>(
      "INSERT INTO orgs.workspaces (owner_user_id, name, kind) VALUES ($1, 'E2E team', 'team') RETURNING id",
      [signedIn.userId],
    );
    workspaceId = required(workspace).id;
    await e2e.query(
      "INSERT INTO orgs.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, signedIn.userId],
    );
  });

  afterAll(async () => {
    await e2e.close();
  });

  it('stores the environments and provisions each one its own branch rules, target, and pipeline', async () => {
    const start = e2e.externalCalls.length;
    const repoName = 'e2e-environments-' + String(Date.now());
    const response = await agent
      .post('/api/v1/projects')
      .send({
        repoName,
        visibility: 'private',
        projectTypeId: 'nestjs',
        serviceName: 'orders-api',
        workspaceId,
        environments: [
          {
            slug: 'dev',
            displayName: 'Test',
            sourceBranch: 'dev',
            role: 'non_production',
          },
          {
            slug: 'qa',
            displayName: 'QA',
            sourceBranch: 'dev',
            role: 'non_production',
          },
          {
            slug: 'main',
            displayName: 'Production',
            sourceBranch: 'main',
            role: 'production',
          },
        ],
        deploymentProvisioning: {
          enabled: true,
          targets: [
            {
              slot: 'backend',
              provider: 'render',
              ownershipMode: 'flowci_managed',
              projectName: 'orders-api',
            },
          ],
        },
      })
      .expect(201);
    const body = response.body as { id: string; branchesCreated: string[] };
    expect(body.branchesCreated).toEqual(['main', 'dev']);

    const environments = await e2e.query<{
      id: string;
      slug: string;
      source_branch: string;
      position: number;
    }>(
      'SELECT id, slug, source_branch, position FROM projects.project_environments WHERE project_id = $1 ORDER BY position',
      [body.id],
    );
    expect(
      environments.map(({ slug, source_branch }) => [slug, source_branch]),
    ).toEqual([
      ['dev', 'dev'],
      ['qa', 'dev'],
      ['main', 'main'],
    ]);
    const idOf = (slug: string) =>
      required(environments.find((environment) => environment.slug === slug))
        .id;

    const calls = e2e.externalCalls.slice(start);
    const argsOf = (method: string) =>
      calls.filter((call) => call.method === method).map(({ args }) => args);
    expect(argsOf('createBranch').map((args) => args[3])).toEqual(['dev']);
    expect(argsOf('applyBranchProtection').map((args) => args[3])).toEqual([
      'main',
    ]);
    expect(
      argsOf('ensureDeploymentEnvironment').map((args) => {
        const input = args[0] as {
          environmentName: string;
          sourceBranch: string;
        };
        return [input.environmentName, input.sourceBranch];
      }),
    ).toEqual([
      ['dev', 'dev'],
      ['qa', 'dev'],
      ['main', 'main'],
    ]);

    const targets = await e2e.query<{
      id: string;
      environment_id: string;
      branch_name: string;
    }>(
      'SELECT id, environment_id, branch_name FROM env_provisioning.project_deployment_targets WHERE project_id = $1',
      [body.id],
    );
    expect(targets).toHaveLength(3);
    const targetOf = (slug: string) =>
      required(
        targets.find(({ environment_id }) => environment_id === idOf(slug)),
      );
    expect(new Set(targets.map(({ id }) => id)).size).toBe(3);
    expect(targetOf('qa').branch_name).toBe('dev');

    const pushes = argsOf('putFileContent').map((args) => ({
      path: args[3] as string,
      content: args[4] as string,
      branch: args[5] as string,
    }));
    const pipeline = (path: string, branch: string) =>
      yaml.load(
        required(
          pushes.find((push) => push.path === path && push.branch === branch),
        ).content,
      ) as Workflow;
    for (const branch of ['dev', 'main']) {
      expect(
        pushes.some(
          (push) =>
            push.branch === branch &&
            push.path.endsWith('20-alphaci-package.yml'),
        ),
      ).toBe(true);
    }
    const deployTargets = (workflow: Workflow) =>
      Object.values(workflow.jobs)
        .filter((job) => /render-deploy\.yml@/.test(job.uses ?? ''))
        .map((job) => job.with?.['target-id']);
    expect(
      deployTargets(
        pipeline('.github/workflows/20-alphaci-package.yml', 'dev'),
      ),
    ).toEqual([targetOf('dev').id]);
    expect(
      deployTargets(
        pipeline('.github/workflows/30-alphaci-promote.yml', 'dev'),
      ),
    ).toEqual([targetOf('qa').id, targetOf('main').id]);
  });
});
