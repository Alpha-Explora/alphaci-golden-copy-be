import {
  startApplication,
  type E2eApplication,
  type SignedInAgent,
} from './support/application';
import { required } from './support/database';

type Target = {
  id: string;
  environmentId: string | null;
  slot: string;
  branchName: string;
  providerProjectId: string;
};

/**
 * Deployment targets keyed by (project, environment, slot). Two environments
 * that share a source branch get separate targets; every rejection happens
 * before GitHub or the provider is called.
 */
describe('Deployment targets by environment', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let userId: string;
  let sequence = 0;

  async function projectWithEnvironments() {
    sequence += 1;
    const [row] = await e2e.query<{ id: string }>(
      `INSERT INTO projects.provisioned_projects
         (user_id, repo_full_name, template_id, service_name, workflow_path, status)
       VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
       RETURNING id`,
      [
        userId,
        'e2e-org/targets-' + String(Date.now()) + '-' + String(sequence),
      ],
    );
    const projectId = required(row).id;
    const environments = '/api/v1/projects/' + projectId + '/environments';
    const production = await agent
      .post(environments)
      .send({
        slug: 'main',
        displayName: 'Production',
        sourceBranch: 'main',
        role: 'production',
      })
      .expect(201);
    const qa = await agent
      .post(environments)
      .send({
        slug: 'qa',
        displayName: 'QA',
        sourceBranch: 'main',
        role: 'non_production',
      })
      .expect(201);
    const uat = await agent
      .post(environments)
      .send({
        slug: 'uat',
        displayName: 'UAT',
        sourceBranch: 'uat',
        role: 'non_production',
      })
      .expect(201);
    return {
      projectId,
      targets: '/api/v1/projects/' + projectId + '/deployment-targets',
      production: (production.body as { id: string }).id,
      qa: (qa.body as { id: string }).id,
      uat: (uat.body as { id: string }).id,
    };
  }

  const renderTarget = (environmentId: string | undefined, name: string) => ({
    action: 'create',
    ...(environmentId ? { environmentId } : {}),
    slot: 'backend',
    ownershipMode: 'flowci_managed',
    provider: 'render',
    projectName: name,
  });

  function callsSince(index: number) {
    return e2e.externalCalls
      .slice(index)
      .map(({ port, method }) => port + '.' + method);
  }

  async function storedTargets(projectId: string) {
    return e2e.query<{ id: string; environment_id: string | null }>(
      'SELECT id, environment_id FROM env_provisioning.project_deployment_targets WHERE project_id = $1',
      [projectId],
    );
  }

  beforeAll(async () => {
    e2e = await startApplication();
    ({ agent, userId } = await e2e.signIn());
  });

  afterAll(async () => {
    await e2e.close();
  });

  afterEach(() => {
    e2e.providers.failGithubEnvironments(false);
  });

  it('gives two environments on one branch separate targets and GitHub Environments', async () => {
    const project = await projectWithEnvironments();
    const start = e2e.externalCalls.length;

    const production = await agent
      .post(project.targets)
      .send(renderTarget(project.production, 'e2e-api-production'))
      .expect(201);
    const qa = await agent
      .post(project.targets)
      .send(renderTarget(project.qa, 'e2e-api-qa'))
      .expect(201);

    const [prod, test] = [production.body as Target, qa.body as Target];
    expect(prod).toMatchObject({
      environmentId: project.production,
      branchName: 'main',
    });
    expect(test).toMatchObject({
      environmentId: project.qa,
      branchName: 'main',
    });
    expect(prod.id).not.toBe(test.id);
    expect(prod.providerProjectId).not.toBe(test.providerProjectId);

    const environmentCalls = e2e.externalCalls
      .slice(start)
      .filter(({ method }) => method === 'ensureDeploymentEnvironment')
      .map(({ args }) => args[0]);
    expect(environmentCalls).toEqual([
      expect.objectContaining({
        environmentName: 'main',
        sourceBranch: 'main',
      }),
      expect.objectContaining({ environmentName: 'qa', sourceBranch: 'main' }),
    ]);

    const listed = await agent
      .get(project.targets)
      .query({ environmentId: project.qa })
      .expect(200);
    expect((listed.body as Target[]).map(({ id }) => id)).toEqual([test.id]);
  });

  it('provisions the GitHub Environment before the provider target', async () => {
    const project = await projectWithEnvironments();
    const start = e2e.externalCalls.length;

    await agent
      .post(project.targets)
      .send(renderTarget(project.uat, 'e2e-api-uat'))
      .expect(201);

    expect(callsSince(start)).toEqual([
      'githubActions.ensureDeploymentEnvironment',
      'provider:render.createTarget',
    ]);
  });

  it('rejects a second target for the same environment and slot', async () => {
    const project = await projectWithEnvironments();
    await agent
      .post(project.targets)
      .send(renderTarget(project.production, 'e2e-api-first'))
      .expect(201);
    const start = e2e.externalCalls.length;

    await agent
      .post(project.targets)
      .send(renderTarget(project.production, 'e2e-api-second'))
      .expect(409);

    expect(callsSince(start)).toEqual([]);
    expect(await storedTargets(project.projectId)).toHaveLength(1);
  });

  it("rejects a target branch other than the environment's source branch", async () => {
    const project = await projectWithEnvironments();
    const start = e2e.externalCalls.length;

    await agent
      .post(project.targets)
      .send({
        ...renderTarget(project.qa, 'e2e-api-wrong-branch'),
        branchName: 'uat',
      })
      .expect(400);

    expect(callsSince(start)).toEqual([]);
    expect(await storedTargets(project.projectId)).toEqual([]);
  });

  it("rejects another project's environment and a malformed environment ID", async () => {
    const first = await projectWithEnvironments();
    const second = await projectWithEnvironments();
    const start = e2e.externalCalls.length;

    await agent
      .post(first.targets)
      .send(renderTarget(second.production, 'e2e-api-foreign'))
      .expect(404);
    await agent
      .post(first.targets)
      .send(renderTarget('not-a-uuid', 'e2e-api-malformed'))
      .expect(400);

    expect(callsSince(start)).toEqual([]);
    expect(await storedTargets(first.projectId)).toEqual([]);
  });

  it('creates nothing when the GitHub Environment cannot be provisioned', async () => {
    const project = await projectWithEnvironments();
    e2e.providers.failGithubEnvironments(true);
    const start = e2e.externalCalls.length;

    await agent
      .post(project.targets)
      .send(renderTarget(project.production, 'e2e-api-no-github'))
      .expect(502);

    expect(callsSince(start)).toEqual([
      'githubActions.ensureDeploymentEnvironment',
    ]);
    expect(await storedTargets(project.projectId)).toEqual([]);
  });

  it('keeps legacy targets on the branch path until an operator attaches them', async () => {
    const project = await projectWithEnvironments();
    const legacy = await agent
      .post(project.targets)
      .send({
        ...renderTarget(undefined, 'e2e-api-legacy'),
        branchName: 'main',
      })
      .expect(201);
    const target = legacy.body as Target;
    expect(target).toMatchObject({ environmentId: null, branchName: 'main' });

    const attach = (environmentId: string) =>
      agent
        .put(project.targets + '/' + target.id + '/environment')
        .send({ environmentId });

    await attach(project.uat).expect(400);
    const attached = await attach(project.qa).expect(200);
    expect(attached.body).toMatchObject({
      id: target.id,
      environmentId: project.qa,
    });
    await attach(project.qa).expect(200);
    await attach(project.production).expect(409);

    expect(await storedTargets(project.projectId)).toEqual([
      { id: target.id, environment_id: project.qa },
    ]);
  });

  it('serves the environment target and refuses an absent or failed one', async () => {
    const project = await projectWithEnvironments();
    const created = await agent
      .post(project.targets)
      .send(renderTarget(project.production, 'e2e-api-url'))
      .expect(201);
    const target = created.body as Target;
    const environmentTarget = (environmentId: string) =>
      agent.get(
        '/api/v1/projects/' +
          project.projectId +
          '/environments/' +
          environmentId +
          '/deployment-targets/backend',
      );

    const found = await environmentTarget(project.production).expect(200);
    expect(found.body).toMatchObject({
      id: target.id,
      environmentId: project.production,
    });

    await environmentTarget(project.qa).expect(404);

    await e2e.query(
      "UPDATE env_provisioning.project_deployment_targets SET status = 'failed' WHERE id = $1",
      [target.id],
    );
    await environmentTarget(project.production).expect(409);
  });
});
