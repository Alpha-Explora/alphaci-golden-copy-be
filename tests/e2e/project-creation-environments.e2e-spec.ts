import yaml from 'js-yaml';

import {
  startApplication,
  type E2eApplication,
  type SignedInAgent,
} from './support/application';
import { required } from './support/database';

type Job = {
  if?: string;
  uses?: string;
  permissions?: Record<string, string>;
  with?: Record<string, unknown>;
  steps?: Array<{ run?: string; env?: Record<string, string> }>;
};
type Workflow = { jobs: Record<string, Job> };

/**
 * Creating a single-repository project with its own ordered environments,
 * through the real provisioning path with GitHub, the CI token issuer, and
 * provider clients faked at their ports. Failure modes: environments stored
 * out of order or not at all; a shared branch created twice; the first
 * environment's branch protected or a later one left unprotected; environments
 * sharing a target or GitHub Environment; the pipeline pushed to a branch it
 * does not run on, deploying a later environment on push, or naming a target
 * of another environment. For the mixed example (hosted test and UAT,
 * on-prem production): production given a hosted target or the other
 * environments an on-prem one; an on-prem target calling a provider or
 * GitHub; the image production pulls never being built because test does not
 * need it; a workflow job deploying production; an image job granting less
 * than the central docker-build scan needs, which GitHub refuses at startup;
 * a created target reported as not provisioned.
 */
describe('Project creation with environments', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let workspaceId: string;
  let commits = 0;
  const installationToken = () => Promise.resolve('e2e-installation-token');

  beforeAll(async () => {
    // Managed Vercel and on-prem hosts are on for the mixed example; every
    // provider client is still a fake.
    process.env['ALPHACI_VERCEL_TOKEN'] = 'e2e-vercel-token';
    process.env['ALPHACI_VERCEL_TEAM_ID'] = 'e2e-vercel-team';
    process.env['ONPREM_RELEASES_ENABLED'] = 'true';
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
        ensurePullRequestProtection: () =>
          Promise.resolve({ status: 'applied' }),
      },
      ciAnswers: {
        issueProjectToken: () =>
          Promise.resolve({ token: 'e2e-ci-token', tokenPrefix: 'e2e-ci' }),
      },
    });
    const signedIn = await e2e.signIn();
    agent = signedIn.agent;
    // An admin can create repositories and configure hosting in the same operation.
    await e2e.query(
      "UPDATE identity.app_users SET app_role = 'admin' WHERE id = $1",
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
    delete process.env['ALPHACI_VERCEL_TOKEN'];
    delete process.env['ALPHACI_VERCEL_TEAM_ID'];
    delete process.env['ONPREM_RELEASES_ENABLED'];
  });

  const pushesSince = (start: number) =>
    e2e.externalCalls
      .slice(start)
      .filter(({ method }) => method === 'putFileContent')
      .map(({ args }) => ({
        path: args[3] as string,
        content: args[4] as string,
        branch: args[5] as string,
      }));

  it('creates hosted test and UAT with on-prem production, building every image production pulls', async () => {
    const start = e2e.externalCalls.length;
    const response = await agent
      .post('/api/v1/projects')
      .send({
        repoName: 'e2e-mixed-' + String(Date.now()),
        visibility: 'private',
        projectTypeId: 'nestjs',
        serviceName: 'shop',
        workspaceId,
        environments: [
          {
            slug: 'dev',
            displayName: 'Test',
            sourceBranch: 'dev',
            role: 'non_production',
          },
          {
            slug: 'uat',
            displayName: 'UAT',
            sourceBranch: 'uat',
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
              projectName: 'shop-api',
            },
            {
              slot: 'frontend',
              provider: 'vercel',
              ownershipMode: 'flowci_managed',
              projectName: 'shop-web',
            },
            {
              slot: 'backend',
              provider: 'onprem-compose',
              ownershipMode: 'byo',
              environmentSlug: 'main',
            },
            {
              slot: 'frontend',
              provider: 'onprem-compose',
              ownershipMode: 'byo',
              environmentSlug: 'main',
            },
          ],
        },
      })
      .expect(201);
    const projectId = (response.body as { id: string }).id;
    expect(
      (
        response.body as {
          deploymentProvisioning: { targets: Array<{ status: string }> };
        }
      ).deploymentProvisioning.targets.map(({ status }) => status),
    ).toEqual(Array(6).fill('created'));

    const targets = await e2e.query<{
      id: string;
      slug: string;
      environment_id: string;
      slot: string;
      provider: string;
    }>(
      `SELECT target.id, environment.slug, target.environment_id, target.slot, target.provider
         FROM env_provisioning.project_deployment_targets AS target
         JOIN projects.project_environments AS environment ON environment.id = target.environment_id
        WHERE target.project_id = $1
        ORDER BY environment.position, target.slot`,
      [projectId],
    );
    expect(
      targets.map(({ slug, slot, provider }) => [slug, slot, provider]),
    ).toEqual([
      ['dev', 'backend', 'render'],
      ['dev', 'frontend', 'vercel'],
      ['uat', 'backend', 'render'],
      ['uat', 'frontend', 'vercel'],
      ['main', 'backend', 'onprem-compose'],
      ['main', 'frontend', 'onprem-compose'],
    ]);
    const targetId = (slug: string, slot: string) =>
      required(
        targets.find((target) => target.slug === slug && target.slot === slot),
      ).id;
    const mainId = required(
      targets.find(({ slug }) => slug === 'main'),
    ).environment_id;

    const calls = e2e.externalCalls.slice(start);
    expect(
      calls
        .filter(({ method }) => method === 'createTarget')
        .map(({ port }) => port)
        .sort(),
    ).toEqual([
      'provider:render',
      'provider:render',
      'provider:vercel',
      'provider:vercel',
    ]);
    expect(
      calls
        .filter(({ method }) => method === 'ensureDeploymentEnvironment')
        .map(
          ({ args }) =>
            (args[0] as { environmentName: string }).environmentName,
        ),
    ).toEqual(['dev', 'dev', 'uat', 'uat']);

    const pushes = pushesSince(start);
    const pipeline = (path: string) =>
      yaml.load(
        required(
          pushes.find((push) => push.path === path && push.branch === 'dev'),
        ).content,
      ) as Workflow;
    const packaged = pipeline('.github/workflows/20-alphaci-package.yml');
    expect(Object.keys(packaged.jobs)).toEqual(
      expect.arrayContaining(['image-backend', 'image-frontend']),
    );
    for (const id of ['image-backend', 'image-frontend']) {
      expect(packaged.jobs[id]?.permissions).toMatchObject({
        packages: 'write',
        'security-events': 'write',
      });
    }
    const register = required(
      packaged.jobs['register-release']?.steps?.[0]?.run,
    );
    expect(register).toContain('slot:"frontend"');
    expect(packaged.jobs['deploy-dev-frontend']?.with?.['target-id']).toBe(
      targetId('dev', 'frontend'),
    );
    expect(
      packaged.jobs['deploy-dev-frontend']?.with?.['artifact'],
    ).toBeUndefined();

    const promoted = pipeline('.github/workflows/30-alphaci-promote.yml');
    const deployJobs = Object.keys(promoted.jobs).filter((id) =>
      id.startsWith('deploy-'),
    );
    expect(deployJobs.sort()).toEqual([
      'deploy-uat-backend',
      'deploy-uat-frontend',
    ]);
    expect(
      required(
        promoted.jobs['release']?.steps?.[0]?.env?.['KNOWN_ENVIRONMENTS'],
      ).split(' '),
    ).not.toContain(mainId);
  });

  it.each<
    [
      string,
      { environments: string; environmentSlug?: string; provider: string },
    ]
  >([
    [
      'a target for an environment the project does not define',
      {
        environments: 'defined',
        environmentSlug: 'staging',
        provider: 'onprem-compose',
      },
    ],
    [
      'an on-prem target without project environments',
      { environments: 'none', provider: 'onprem-compose' },
    ],
  ])('refuses %s before creating the repository', async (_case, change) => {
    const start = e2e.externalCalls.length;
    await agent
      .post('/api/v1/projects')
      .send({
        repoName: 'e2e-refused-' + String(Date.now()),
        visibility: 'private',
        projectTypeId: 'nestjs',
        serviceName: 'refused',
        workspaceId,
        ...(change.environments === 'defined'
          ? {
              environments: [
                {
                  slug: 'main',
                  displayName: 'Production',
                  sourceBranch: 'main',
                  role: 'production',
                },
              ],
            }
          : {}),
        deploymentProvisioning: {
          enabled: true,
          targets: [
            {
              slot: 'backend',
              provider: change.provider,
              ownershipMode: 'byo',
              ...(change.environmentSlug
                ? { environmentSlug: change.environmentSlug }
                : {}),
            },
          ],
        },
      })
      .expect(400);
    expect(
      e2e.externalCalls.slice(start).map(({ method }) => method),
    ).not.toContain('createRepo');
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
    expect(
      argsOf('ensurePullRequestProtection').map((args) => args[3]),
    ).toEqual(['main']);
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
