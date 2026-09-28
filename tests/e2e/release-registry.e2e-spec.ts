import { createHash, randomBytes } from 'node:crypto';

import request from 'supertest';

import { canonicalJson } from '../../src/modules/runtime/domain/release-manifest';
import {
  startApplication,
  type E2eApplication,
  type SignedInAgent,
} from './support/application';
import { required } from './support/database';

type Deployment = {
  id: string;
  environmentId: string;
  trigger: string;
  status: string;
  targetIds: string[];
};
type Release = {
  releaseId: string;
  verificationStatus: string;
  manifestSha256: string | null;
  deployments: Deployment[];
};

const digest = (character: string) => 'sha256:' + character.repeat(64);
const sha = (character: string) => character.repeat(40);

/**
 * Immutable releases, signed manifests, explicit promotion between ordered
 * environments, and on-prem host polling, through the real CI-token, session,
 * and host-token boundaries.
 */
describe('Release registry and promotion', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let userId: string;
  let sequence = 0;

  async function releaseProject() {
    sequence += 1;
    const repo =
      'e2e-org/releases-' + String(Date.now()) + '-' + String(sequence);
    const [project] = await e2e.query<{ id: string }>(
      `INSERT INTO projects.provisioned_projects
         (user_id, repo_full_name, template_id, service_name, workflow_path, status)
       VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
       RETURNING id`,
      [userId, repo],
    );
    const projectId = required(project).id;
    const environment = async (slug: string, position: number, role: string) =>
      required(
        (
          await e2e.query<{ id: string }>(
            `INSERT INTO projects.project_environments
               (project_id, slug, display_name, position, source_branch, role, auto_deploy)
             VALUES ($1, $2, $2, $3, $2, $4, $5) RETURNING id`,
            [projectId, slug, position, role, position === 0],
          )
        )[0],
      ).id;
    const dev = await environment('dev', 0, 'non_production');
    const uat = await environment('uat', 1, 'non_production');
    const main = await environment('main', 2, 'production');
    const target = async (environmentId: string, branch: string) =>
      required(
        (
          await e2e.query<{ id: string }>(
            `INSERT INTO env_provisioning.project_deployment_targets
               (project_id, environment_id, slot, ownership_mode, provider, provider_project_id,
                provider_project_name, repo_full_name, branch_name, deployment_strategy)
             VALUES ($1, $2, 'backend', 'flowci_managed', 'render', $3, $3, $4, $5, 'render_image_pushed')
             RETURNING id`,
            [projectId, environmentId, repo + '-' + branch, repo, branch],
          )
        )[0],
      ).id;
    const token = 'e2e_ci_' + randomBytes(16).toString('hex');
    await e2e.query(
      `INSERT INTO ci.project_ci_tokens (project_id, token_hash, token_prefix, status)
       VALUES ($1, $2, $3, 'active')`,
      [
        projectId,
        createHash('sha256').update(token).digest('hex'),
        token.slice(0, 10),
      ],
    );
    return {
      projectId,
      repo,
      token,
      dev,
      uat,
      main,
      devTarget: await target(dev, 'dev'),
      uatTarget: await target(uat, 'uat'),
      addMainTarget: () => target(main, 'main'),
    };
  }

  type Project = Awaited<ReturnType<typeof releaseProject>>;

  const registration = (
    project: Project,
    overrides: Record<string, unknown> = {},
  ) => ({
    repoFullName: project.repo,
    sourceEnvironmentId: project.dev,
    sourceBranch: 'dev',
    commitSha: sha('a'),
    artifacts: [
      { slot: 'backend', reference: 'ghcr.io/e2e-org/api@' + digest('b') },
    ],
    workflowRun: {
      provider: 'github_actions',
      repo: project.repo,
      runId: String(Date.now()) + String(sequence),
      url: 'https://github.com/' + project.repo + '/actions/runs/1',
    },
    ...overrides,
  });

  const ci = (project: Project) => ({
    Authorization: 'Bearer ' + project.token,
  });

  async function register(
    project: Project,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(e2e.http)
      .post('/api/v1/ci/releases')
      .set(ci(project))
      .send(registration(project, overrides))
      .expect(202);
    return response.body as Release;
  }

  function signedManifest(project: Project, release: Release) {
    const body = registration(project);
    const manifest = {
      schemaVersion: 1,
      releaseId: release.releaseId,
      projectId: project.projectId,
      sourceEnvironmentId: project.dev,
      sourceBranch: 'dev',
      commitSha: sha('a'),
      createdAt: '2026-09-28T00:00:00.000Z',
      artifacts: [
        { slot: 'backend', image: 'ghcr.io/e2e-org/api', digest: digest('b') },
      ],
      workflowRun:
        (release as unknown as { workflowRun: unknown }).workflowRun ??
        body.workflowRun,
    };
    return {
      repoFullName: project.repo,
      manifest,
      manifestSha256: createHash('sha256')
        .update(canonicalJson(manifest))
        .digest('hex'),
      signature: {
        algorithm: 'ecdsa-p256-sha256',
        keyId: 'projects/e2e/keys/release/1',
        value: 'c2lnbmF0dXJl',
      },
    };
  }

  const attach = (project: Project, release: Release, body: object) =>
    request(e2e.http)
      .put('/api/v1/ci/releases/' + release.releaseId + '/manifest')
      .set(ci(project))
      .send(body);

  const reportDev = (project: Project, release: Release, status: string) =>
    request(e2e.http)
      .post('/api/v1/ci/releases/' + release.releaseId + '/deployment-status')
      .set(ci(project))
      .send({ repoFullName: project.repo, status })
      .expect(200);

  const promote = (project: Project, environmentId: string, release: Release) =>
    agent
      .post(
        '/api/v1/projects/' +
          project.projectId +
          '/environments/' +
          environmentId +
          '/promotions',
      )
      .send({ releaseId: release.releaseId });

  async function releaseCount(projectId: string) {
    const [row] = await e2e.query<{ count: string }>(
      'SELECT count(*) FROM env_provisioning.releases WHERE project_id = $1',
      [projectId],
    );
    return Number(required(row).count);
  }

  /** A verified release that dev runs, ready to promote. */
  async function devRelease(project: Project) {
    const release = await register(project);
    await attach(project, release, signedManifest(project, release)).expect(
      200,
    );
    await reportDev(project, release, 'deploying');
    await reportDev(project, release, 'healthy');
    return release;
  }

  describe('with on-prem hosts disabled', () => {
    it('does not expose host registration or the host agent', async () => {
      delete process.env['ONPREM_RELEASES_ENABLED'];
      const disabled = await startApplication();
      try {
        const signedIn = await disabled.signIn();
        const [project] = await disabled.query<{ id: string }>(
          `INSERT INTO projects.provisioned_projects
             (user_id, repo_full_name, template_id, service_name, workflow_path, status)
           VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
           RETURNING id`,
          [signedIn.userId, 'e2e-org/onprem-off-' + String(Date.now())],
        );
        await signedIn.agent
          .post(
            '/api/v1/projects/' +
              required(project).id +
              '/environments/' +
              randomUuid() +
              '/hosts',
          )
          .send({ name: 'lab' })
          .expect(404);
        await request(disabled.http)
          .get('/api/v1/onprem/assignments')
          .set({ Authorization: 'Bearer aoh_anything' })
          .expect(404);
      } finally {
        await disabled.close();
      }
    });
  });

  describe('with on-prem hosts enabled', () => {
    beforeAll(async () => {
      process.env['ONPREM_RELEASES_ENABLED'] = 'true';
      e2e = await startApplication();
      ({ agent, userId } = await e2e.signIn());
    });

    afterAll(async () => {
      await e2e.close();
      delete process.env['ONPREM_RELEASES_ENABLED'];
    });

    it("registers a release for the first environment and records dev's automatic deployment", async () => {
      const project = await releaseProject();
      const release = await register(project);

      expect(release).toMatchObject({
        verificationStatus: 'pending',
        manifestSha256: null,
      });
      expect(release.deployments).toEqual([
        expect.objectContaining({
          environmentId: project.dev,
          trigger: 'automatic',
          status: 'pending',
          targetIds: [project.devTarget],
        }),
      ]);

      const read = await request(e2e.http)
        .get('/api/v1/ci/releases/' + release.releaseId)
        .query({ repo: project.repo })
        .set(ci(project))
        .expect(200);
      expect((read.body as Release).releaseId).toBe(release.releaseId);
    });

    it.each([
      [
        'a floating image tag',
        {
          artifacts: [
            { slot: 'backend', reference: 'ghcr.io/e2e-org/api:latest' },
          ],
        },
      ],
      ['a short commit SHA', { commitSha: 'abc1234' }],
      ['a later environment as the source', 'uat'],
      [
        'a branch other than the first environment branch',
        { sourceBranch: 'main' },
      ],
      ['a workflow run from another repository', 'foreign-run'],
    ])('refuses %s and stores nothing', async (_case, change) => {
      const project = await releaseProject();
      const overrides =
        change === 'uat'
          ? { sourceEnvironmentId: project.uat, sourceBranch: 'uat' }
          : change === 'foreign-run'
            ? {
                workflowRun: {
                  ...registration(project).workflowRun,
                  repo: 'someone/else',
                },
              }
            : change;
      await request(e2e.http)
        .post('/api/v1/ci/releases')
        .set(ci(project))
        .send(registration(project, overrides as Record<string, unknown>))
        .expect(400);
      expect(await releaseCount(project.projectId)).toBe(0);
    });

    it("keeps one project's CI token out of another project's releases", async () => {
      const owner = await releaseProject();
      const other = await releaseProject();
      const release = await register(owner);

      await request(e2e.http)
        .post('/api/v1/ci/releases')
        .set(ci(other))
        .send(registration(owner))
        .expect(403);
      await request(e2e.http)
        .get('/api/v1/ci/releases/' + release.releaseId)
        .query({ repo: other.repo })
        .set(ci(other))
        .expect(404);
    });

    it('still validates the legacy branch release request', async () => {
      const project = await releaseProject();
      await request(e2e.http)
        .post('/api/v1/ci/releases')
        .set(ci(project))
        .send({
          repoFullName: project.repo,
          slot: 'backend',
          branch: 'feature',
          commitSha: sha('a'),
        })
        .expect(400);
      await request(e2e.http)
        .get('/api/v1/ci/releases/not-a-target.release')
        .query({ repo: project.repo })
        .set(ci(project))
        .expect(404);
      expect(await releaseCount(project.projectId)).toBe(0);
    });

    it('accepts only a signed manifest that restates the release, once', async () => {
      const project = await releaseProject();
      const release = await register(project);
      const signed = signedManifest(project, release);

      await attach(project, release, {
        ...signed,
        manifestSha256: 'f'.repeat(64),
      }).expect(400);
      await attach(project, release, {
        ...signed,
        manifest: { ...signed.manifest, commitSha: sha('c') },
      }).expect(400);
      await attach(project, release, {
        ...signed,
        signature: { ...signed.signature, algorithm: 'none' },
      }).expect(400);

      const verified = await attach(project, release, signed).expect(200);
      expect(verified.body).toMatchObject({
        verificationStatus: 'verified',
        manifestSha256: signed.manifestSha256,
      });
      await attach(project, release, signed).expect(200);
      await attach(project, release, {
        ...signed,
        signature: { ...signed.signature, value: 'b3RoZXI=' },
      }).expect(409);
    });

    it('refuses to change a registered release, even directly in the database', async () => {
      const project = await releaseProject();
      const release = await register(project);
      await expect(
        e2e.query(
          'UPDATE env_provisioning.releases SET commit_sha = $2 WHERE id = $1',
          [release.releaseId, sha('d')],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        e2e.query(
          'UPDATE env_provisioning.release_artifacts SET digest = $2 WHERE release_id = $1',
          [release.releaseId, digest('e')],
        ),
      ).rejects.toThrow(/immutable/);
    });

    it('promotes only the verified release the previous environment runs', async () => {
      const project = await releaseProject();
      const release = await register(project);

      await promote(project, project.uat, release).expect(409);
      await reportDev(project, release, 'deploying');
      await reportDev(project, release, 'healthy');
      await promote(project, project.uat, release).expect(409);

      await attach(project, release, signedManifest(project, release)).expect(
        200,
      );
      await promote(project, project.dev, release).expect(400);
      await promote(project, project.main, release).expect(409);

      const promoted = await promote(project, project.uat, release).expect(201);
      expect(promoted.body).toMatchObject({
        environmentId: project.uat,
        trigger: 'promotion',
        status: 'pending',
        targetIds: [project.uatTarget],
      });
      await promote(project, project.uat, release).expect(409);
    });

    it('refuses promotion by a CI token or an unauthenticated caller', async () => {
      const project = await releaseProject();
      const release = await devRelease(project);
      const path =
        '/api/v1/projects/' +
        project.projectId +
        '/environments/' +
        project.uat +
        '/promotions';

      await request(e2e.http)
        .post(path)
        .set(ci(project))
        .send({ releaseId: release.releaseId })
        .expect(401);
      await request(e2e.http)
        .post(path)
        .send({ releaseId: release.releaseId })
        .expect(401);
    });

    it('gives each host only its environment and moves deployments forward only', async () => {
      const project = await releaseProject();
      const release = await devRelease(project);
      const promoted = (
        await promote(project, project.uat, release).expect(201)
      ).body as Deployment;

      const host = async (environmentId: string) =>
        (
          await agent
            .post(
              '/api/v1/projects/' +
                project.projectId +
                '/environments/' +
                environmentId +
                '/hosts',
            )
            .send({ name: 'lab-' + environmentId.slice(0, 8) })
            .expect(201)
        ).body as { token: string };
      const uatHost = await host(project.uat);
      const devHost = await host(project.dev);
      const as = (token: string) => ({ Authorization: 'Bearer ' + token });

      const assignments = await request(e2e.http)
        .get('/api/v1/onprem/assignments')
        .set(as(uatHost.token))
        .expect(200);
      expect(assignments.body).toEqual([
        {
          deploymentId: promoted.id,
          status: 'pending',
          assignment: {
            projectId: project.projectId,
            environmentId: project.uat,
            targetIds: [project.uatTarget],
          },
          envelope: {
            manifest: expect.objectContaining({
              releaseId: release.releaseId,
            }) as unknown,
            manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
            signature: expect.objectContaining({
              algorithm: 'ecdsa-p256-sha256',
            }) as unknown,
          },
        },
      ]);
      const devAssignments = await request(e2e.http)
        .get('/api/v1/onprem/assignments')
        .set(as(devHost.token))
        .expect(200);
      expect(devAssignments.body).toEqual([]);

      const status = (token: string, value: string) =>
        request(e2e.http)
          .post('/api/v1/onprem/deployments/' + promoted.id + '/status')
          .set(as(token))
          .send({ status: value });
      await status(devHost.token, 'deploying').expect(404);
      await status('aoh_not-a-real-token', 'deploying').expect(401);
      await status(uatHost.token, 'healthy').expect(409);
      await status(uatHost.token, 'deploying').expect(201);
      await status(uatHost.token, 'healthy').expect(201);
      await status(uatHost.token, 'deploying').expect(409);
    });

    it('refuses to promote to an environment without a target, then promotes once it has one', async () => {
      const project = await releaseProject();
      const release = await devRelease(project);
      const uat = (await promote(project, project.uat, release).expect(201))
        .body as Deployment;
      const [host] = [
        (
          await agent
            .post(
              '/api/v1/projects/' +
                project.projectId +
                '/environments/' +
                project.uat +
                '/hosts',
            )
            .send({ name: 'lab-uat' })
            .expect(201)
        ).body as { token: string },
      ];
      for (const value of ['deploying', 'healthy']) {
        await request(e2e.http)
          .post('/api/v1/onprem/deployments/' + uat.id + '/status')
          .set({ Authorization: 'Bearer ' + host.token })
          .send({ status: value })
          .expect(201);
      }

      await promote(project, project.main, release).expect(409);
      const mainTarget = await project.addMainTarget();
      const production = await promote(project, project.main, release).expect(
        201,
      );
      expect(production.body).toMatchObject({
        environmentId: project.main,
        targetIds: [mainTarget],
      });
    });
    it('starts the promotion workflow for a managed destination', async () => {
      const project = await releaseProject();
      const release = await devRelease(project);
      const start = e2e.externalCalls.length;

      const promoted = (
        await promote(project, project.uat, release).expect(201)
      ).body as Deployment;

      const dispatches = e2e.externalCalls
        .slice(start)
        .filter(({ method }) => method === 'dispatchWorkflow')
        .map(({ args }) => args[0]);
      expect(dispatches).toEqual([
        {
          userId,
          repoFullName: project.repo,
          workflowFile: '30-alphaci-promote.yml',
          ref: 'dev',
          inputs: {
            'release-id': release.releaseId,
            'deployment-id': promoted.id,
            'environment-id': project.uat,
          },
        },
      ]);
    });

    it('fails the deployment when the promotion workflow cannot start, so it can be retried', async () => {
      const project = await releaseProject();
      const release = await devRelease(project);

      e2e.providers.failWorkflowDispatch(true);
      try {
        await promote(project, project.uat, release).expect(502);
      } finally {
        e2e.providers.failWorkflowDispatch(false);
      }
      const [failed] = await e2e.query<{ status: string }>(
        'SELECT status FROM env_provisioning.environment_deployments WHERE environment_id = $1',
        [project.uat],
      );
      expect(required(failed).status).toBe('failed');

      await promote(project, project.uat, release).expect(201);
    });

    it("lets CI report only its own project's promoted deployments, forward only", async () => {
      const project = await releaseProject();
      const other = await releaseProject();
      const release = await devRelease(project);
      const promoted = (
        await promote(project, project.uat, release).expect(201)
      ).body as Deployment;
      const report = (by: Project, deploymentId: string, status: string) =>
        request(e2e.http)
          .post('/api/v1/ci/deployments/' + deploymentId + '/status')
          .set(ci(by))
          .send({ repoFullName: by.repo, status });

      await report(other, promoted.id, 'deploying').expect(404);
      await report(project, release.deployments[0]!.id, 'deploying').expect(
        404,
      );
      await report(project, promoted.id, 'healthy').expect(409);
      await report(project, promoted.id, 'deploying').expect(200);
      await report(project, promoted.id, 'healthy').expect(200);
      await report(project, promoted.id, 'failed').expect(409);
    });
  });
});

function randomUuid(): string {
  const hex = randomBytes(16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-4' +
    hex.slice(13, 16) +
    '-a' +
    hex.slice(17, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
