import request from 'supertest';

import {
  startApplication,
  type E2eApplication,
  type SignedInAgent,
} from './support/application';
import { required } from './support/database';

type EnvironmentBody = {
  id: string;
  slug: string;
  displayName: string;
  position: number;
  sourceBranch: string;
  role: string;
  autoDeploy: boolean;
};

describe('Project environments API', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let userId: string;
  let sequence = 0;

  const path = (projectId: string) =>
    '/api/v1/projects/' + projectId + '/environments';

  /** A project as the legacy creation path leaves it: no environment rows. */
  async function legacyProject(ownerId = userId): Promise<string> {
    sequence += 1;
    const [row] = await e2e.query<{ id: string }>(
      `INSERT INTO projects.provisioned_projects
         (user_id, repo_full_name, template_id, service_name, workflow_path, status)
       VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
       RETURNING id`,
      [
        ownerId,
        'e2e-org/legacy-' + String(Date.now()) + '-' + String(sequence),
      ],
    );
    return required(row).id;
  }

  async function storedEnvironments(projectId: string) {
    return e2e.query<{ slug: string; source_branch: string; role: string }>(
      `SELECT slug, source_branch, role FROM projects.project_environments
        WHERE project_id = $1 ORDER BY position`,
      [projectId],
    );
  }

  const production = {
    slug: 'main',
    displayName: 'Production',
    sourceBranch: 'main',
    role: 'production',
  };

  beforeAll(async () => {
    e2e = await startApplication();
    ({ agent, userId } = await e2e.signIn());
  });

  afterAll(async () => {
    await e2e.close();
  });

  it('lists no environments for an unmapped legacy project', async () => {
    const projectId = await legacyProject();
    const response = await agent.get(path(projectId)).expect(200);
    expect(response.body).toEqual([]);
  });

  it('appends ordered environments, and two may share one source branch', async () => {
    const projectId = await legacyProject();

    const first = await agent
      .post(path(projectId))
      .send(production)
      .expect(201);
    expect(first.body).toMatchObject({ position: 0, autoDeploy: true });

    const second = await agent
      .post(path(projectId))
      .send({
        slug: 'qa',
        displayName: 'QA',
        sourceBranch: 'main',
        role: 'non_production',
      })
      .expect(201);
    expect(second.body).toMatchObject({ position: 1, autoDeploy: false });

    const listed = await agent.get(path(projectId)).expect(200);
    const body = listed.body as EnvironmentBody[];
    expect(
      body.map(({ slug, position, sourceBranch }) => ({
        slug,
        position,
        sourceBranch,
      })),
    ).toEqual([
      { slug: 'main', position: 0, sourceBranch: 'main' },
      { slug: 'qa', position: 1, sourceBranch: 'main' },
    ]);
    expect(new Set(body.map(({ id }) => id)).size).toBe(2);
  });

  it('requires the first environment of a legacy project to be production', async () => {
    const projectId = await legacyProject();
    await agent
      .post(path(projectId))
      .send({ ...production, slug: 'dev', role: 'non_production' })
      .expect(400);
    expect(await storedEnvironments(projectId)).toEqual([]);
  });

  it('rejects a second production environment', async () => {
    const projectId = await legacyProject();
    await agent.post(path(projectId)).send(production).expect(201);
    await agent
      .post(path(projectId))
      .send({ ...production, slug: 'prod-two' })
      .expect(400);
    expect(await storedEnvironments(projectId)).toHaveLength(1);
  });

  it('rejects a duplicate slug', async () => {
    const projectId = await legacyProject();
    await agent.post(path(projectId)).send(production).expect(201);
    await agent
      .post(path(projectId))
      .send({ ...production, role: 'non_production', sourceBranch: 'uat' })
      .expect(409);
    expect(await storedEnvironments(projectId)).toHaveLength(1);
  });

  it('renames the display name and keeps the identity', async () => {
    const projectId = await legacyProject();
    const created = await agent
      .post(path(projectId))
      .send(production)
      .expect(201);
    const environment = created.body as EnvironmentBody;

    const renamed = await agent
      .patch(path(projectId) + '/' + environment.id)
      .send({ displayName: 'Customer production' })
      .expect(200);

    expect(renamed.body).toEqual({
      ...environment,
      displayName: 'Customer production',
    });
  });

  it.each([
    ['source branch', { sourceBranch: 'release' }],
    ['role', { role: 'non_production' }],
    ['slug', { slug: 'renamed' }],
    ['order', { position: 3 }],
  ])(
    'rejects a change to the %s of a live environment',
    async (_field, change) => {
      const projectId = await legacyProject();
      const created = await agent
        .post(path(projectId))
        .send(production)
        .expect(201);
      const environment = created.body as EnvironmentBody;

      await agent
        .patch(path(projectId) + '/' + environment.id)
        .send({ displayName: 'Changed', ...change })
        .expect(400);

      expect(await storedEnvironments(projectId)).toEqual([
        { slug: 'main', source_branch: 'main', role: 'production' },
      ]);
    },
  );

  it('offers no way to delete an environment', async () => {
    const projectId = await legacyProject();
    const created = await agent
      .post(path(projectId))
      .send(production)
      .expect(201);
    const environment = created.body as EnvironmentBody;

    await agent.delete(path(projectId) + '/' + environment.id).expect(404);
    expect(await storedEnvironments(projectId)).toHaveLength(1);
  });

  it('refuses unauthenticated requests', async () => {
    const projectId = await legacyProject();
    await request(e2e.http).get(path(projectId)).expect(401);
    await request(e2e.http).post(path(projectId)).send(production).expect(401);
    expect(await storedEnvironments(projectId)).toEqual([]);
  });

  it("hides another user's project", async () => {
    const [other] = await e2e.query<{ id: string }>(
      `INSERT INTO identity.app_users (login, github_user_id)
       VALUES ($1, $1) RETURNING id`,
      ['e2e-other-' + String(Date.now())],
    );
    const projectId = await legacyProject(required(other).id);

    await agent.get(path(projectId)).expect(404);
    await agent.post(path(projectId)).send(production).expect(404);
    expect(await storedEnvironments(projectId)).toEqual([]);
  });

  it('rejects a create-time environment list before any external write', async () => {
    const [before] = await e2e.query<{ count: string }>(
      'SELECT count(*) FROM projects.provisioned_projects',
    );
    const callsBefore = e2e.externalCalls.length;

    const response = await agent
      .post('/api/v1/projects')
      .send({
        repoName: 'e2e-custom-environments',
        visibility: 'private',
        projectTypeId: 'node-api',
        serviceName: 'api',
        environments: [
          production,
          {
            slug: 'qa',
            displayName: 'QA',
            sourceBranch: 'main',
            role: 'non_production',
          },
        ],
      })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain(
      'Custom project environments are not yet supported',
    );
    expect(e2e.externalCalls.slice(callsBefore)).toEqual([]);
    const [after] = await e2e.query<{ count: string }>(
      'SELECT count(*) FROM projects.provisioned_projects',
    );
    expect(required(after).count).toBe(required(before).count);
  });

  it('rejects an invalid create-time environment list before any external write', async () => {
    const callsBefore = e2e.externalCalls.length;

    const response = await agent
      .post('/api/v1/projects')
      .send({
        repoName: 'e2e-two-productions',
        visibility: 'private',
        projectTypeId: 'node-api',
        serviceName: 'api',
        environments: [production, { ...production, slug: 'prod-two' }],
      })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain(
      'production environment count',
    );
    expect(e2e.externalCalls.slice(callsBefore)).toEqual([]);
  });
});
