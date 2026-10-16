import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

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
// The Cloud KMS key version that signs releases is also the trust key ID, so
// the configured signer and the manifest signature name the same key.
const releaseKeyId =
  'projects/e2e/locations/global/keyRings/release/cryptoKeys/alphaci/cryptoKeyVersions/1';
const releaseSigningKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const previousTrustKeys = process.env['ALPHACI_RELEASE_TRUST_KEYS_JSON'];
const previousOnpremFlag = process.env['ONPREM_RELEASES_ENABLED'];
/**
 * A backend with Cloud KMS signing configured. An on-prem target is refused
 * without it, so every scenario that adds one runs with it.
 */
const signingEnvironment = {
  ALPHACI_RELEASE_KMS_KEY_VERSION: releaseKeyId,
  ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER:
    'projects/123456789/locations/global/workloadIdentityPools/alphaci-signer/providers/github',
  ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT:
    'release-signer@e2e-project.iam.gserviceaccount.com',
};
const previousSigningEnvironment = Object.fromEntries(
  Object.keys(signingEnvironment).map((key) => [key, process.env[key]]),
);

/**
 * Immutable releases, signed manifests, explicit promotion between ordered
 * environments, and on-prem host polling, through the real CI-token, session,
 * and host-token boundaries.
 *
 * On-prem failure modes: an on-prem target that calls a provider or GitHub;
 * an environment mixing on-prem and hosted targets; a promotion to an on-prem
 * environment that starts a workflow; a CI token reporting a host's
 * deployment, or a host seeing or reporting a workflow's; on-prem targets
 * accepted while on-prem hosts are off.
 */
describe('Release registry and promotion', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let userId: string;
  let sequence = 0;

  /** dev, uat, and main; Render targets unless an environment is on-prem. */
  async function releaseProject(onprem: Array<'dev' | 'uat' | 'main'> = []) {
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
    const target = async (environmentId: string, branch: string) => {
      const host = (onprem as string[]).includes(branch);
      return required(
        (
          await e2e.query<{ id: string }>(
            `INSERT INTO env_provisioning.project_deployment_targets
               (project_id, environment_id, slot, ownership_mode, provider, provider_project_id,
                provider_project_name, repo_full_name, branch_name, deployment_strategy)
             VALUES ($1, $2, 'backend', $6, $7, $3, $3, $4, $5, $8)
             RETURNING id`,
            [
              projectId,
              environmentId,
              repo + '-' + branch,
              repo,
              branch,
              host ? 'byo' : 'flowci_managed',
              host ? 'onprem-compose' : 'render',
              host ? 'provider_native' : 'render_image_pushed',
            ],
          )
        )[0],
      ).id;
    };
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
    const canonical = canonicalJson(manifest);
    return {
      repoFullName: project.repo,
      manifest,
      manifestSha256: createHash('sha256').update(canonical).digest('hex'),
      signature: {
        algorithm: 'ecdsa-p256-sha256',
        keyId: releaseKeyId,
        value: sign(
          'sha256',
          Buffer.from(canonical),
          releaseSigningKeys.privateKey,
        ).toString('base64'),
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

  const createTarget = (project: Project, body: Record<string, unknown>) =>
    agent
      .post('/api/v1/projects/' + project.projectId + '/deployment-targets')
      .send(body);

  const onpremTarget = (environmentId: string | undefined) => ({
    action: 'create',
    ...(environmentId ? { environmentId } : {}),
    slot: 'backend',
    ownershipMode: 'byo',
    provider: 'onprem-compose',
    projectName: 'lab-api',
  });

  const addHost = async (project: Project, environmentId: string) =>
    (
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
      ).body as { token: string }
    ).token;

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

        const [environment] = await disabled.query<{ id: string }>(
          `INSERT INTO projects.project_environments
             (project_id, slug, display_name, position, source_branch, role, auto_deploy)
           VALUES ($1, 'main', 'main', 0, 'main', 'production', true) RETURNING id`,
          [required(project).id],
        );
        const refused = await signedIn.agent
          .post(
            '/api/v1/projects/' + required(project).id + '/deployment-targets',
          )
          .send(onpremTarget(required(environment).id))
          .expect(400);
        expect(JSON.stringify(refused.body)).toMatch(/not enabled/);
        expect(await onpremDiscovery(signedIn.agent)).toMatchObject({
          enabled: false,
          capabilities: { connectivity: 'indirect' },
        });
      } finally {
        await disabled.close();
      }
    });
  });

  describe('with on-prem hosts enabled', () => {
    beforeAll(async () => {
      process.env['ONPREM_RELEASES_ENABLED'] = 'true';
      process.env['ALPHACI_RELEASE_TRUST_KEYS_JSON'] = JSON.stringify({
        [releaseKeyId]: releaseSigningKeys.publicKey.export({
          type: 'spki',
          format: 'pem',
        }),
      });
      Object.assign(process.env, signingEnvironment);
      // Quick-login has no GitHub token; a GitHub sign-in stores one, and the
      // on-prem target's signing step needs it.
      e2e = await startApplication({ githubAccessToken: 'e2e-github-token' });
      ({ agent, userId } = await e2e.signIn('admin'));
    });

    afterAll(async () => {
      await e2e.close();
      if (previousOnpremFlag === undefined) {
        delete process.env['ONPREM_RELEASES_ENABLED'];
      } else {
        process.env['ONPREM_RELEASES_ENABLED'] = previousOnpremFlag;
      }
      if (previousTrustKeys === undefined) {
        delete process.env['ALPHACI_RELEASE_TRUST_KEYS_JSON'];
      } else {
        process.env['ALPHACI_RELEASE_TRUST_KEYS_JSON'] = previousTrustKeys;
      }
      for (const [key, value] of Object.entries(previousSigningEnvironment)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
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

    it('recovers an unsigned host release after signing fails without accepting a late signature', async () => {
      const project = await releaseProject(['dev']);
      const token = await addHost(project, project.dev);
      const release = await register(project);
      const assignments = () =>
        request(e2e.http)
          .get('/api/v1/onprem/assignments')
          .set({ Authorization: 'Bearer ' + token });
      expect((await assignments().expect(200)).body).toEqual([]);

      const fail = () =>
        request(e2e.http)
          .post(
            '/api/v1/ci/releases/' + release.releaseId + '/deployment-status',
          )
          .set(ci(project))
          .send({
            repoFullName: project.repo,
            status: 'failed',
            detail: 'Release signing failed.',
          });
      expect((await fail().expect(200)).body).toMatchObject({
        status: 'failed',
      });
      await fail().expect(200);
      await attach(project, release, signedManifest(project, release)).expect(
        409,
      );
      expect((await assignments().expect(200)).body).toEqual([]);

      await register(project, {
        workflowRun: {
          ...registration(project).workflowRun,
          runId: '987654321',
        },
      });
    });

    it('replaces the active host token only in its own environment, including concurrent registrations', async () => {
      const project = await releaseProject(['dev', 'uat']);
      const otherProject = await releaseProject(['dev']);
      const original = await addHost(project, project.dev);
      const otherEnvironment = await addHost(project, project.uat);
      const otherProjectToken = await addHost(otherProject, otherProject.dev);
      const release = await register(project);
      await attach(project, release, signedManifest(project, release)).expect(
        200,
      );
      const poll = (token: string) =>
        request(e2e.http)
          .get('/api/v1/onprem/assignments')
          .set({ Authorization: 'Bearer ' + token });
      expect((await poll(original).expect(200)).body).toHaveLength(1);

      const replacement = await addHost(project, project.dev);
      await poll(original).expect(401);
      await request(e2e.http)
        .post(
          '/api/v1/onprem/deployments/' +
            required(release.deployments[0]).id +
            '/status',
        )
        .set({ Authorization: 'Bearer ' + original })
        .send({ status: 'deploying' })
        .expect(401);
      expect((await poll(replacement).expect(200)).body).toHaveLength(1);

      const replacements = await Promise.all([
        addHost(project, project.dev),
        addHost(project, project.dev),
      ]);
      await poll(replacement).expect(401);
      const outcomes = await Promise.all(
        replacements.map((token) => poll(token)),
      );
      expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 401]);
      await poll(otherEnvironment).expect(200);
      await poll(otherProjectToken).expect(200);
    });

    it('keeps CI from taking over a signed host deployment', async () => {
      const project = await releaseProject(['dev']);
      const release = await register(project);
      const report = (status: string) =>
        request(e2e.http)
          .post(
            '/api/v1/ci/releases/' + release.releaseId + '/deployment-status',
          )
          .set(ci(project))
          .send({ repoFullName: project.repo, status });
      for (const status of ['deploying', 'healthy', 'rolled_back']) {
        await report(status).expect(409);
      }
      await attach(project, release, signedManifest(project, release)).expect(
        200,
      );
      for (const status of ['deploying', 'healthy', 'failed', 'rolled_back']) {
        await report(status).expect(409);
      }
      const token = await addHost(project, project.dev);
      await request(e2e.http)
        .post(
          '/api/v1/onprem/deployments/' +
            required(release.deployments[0]).id +
            '/status',
        )
        .set({ Authorization: 'Bearer ' + token })
        .send({ status: 'deploying' })
        .expect(201);
      await report('failed').expect(409);
    });

    it('serializes signing against failure cleanup so exactly one can succeed', async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const project = await releaseProject(['dev']);
        const release = await register(project);
        const [signed, failed] = await Promise.all([
          attach(project, release, signedManifest(project, release)),
          request(e2e.http)
            .post(
              '/api/v1/ci/releases/' + release.releaseId + '/deployment-status',
            )
            .set(ci(project))
            .send({ repoFullName: project.repo, status: 'failed' }),
        ]);
        expect([signed.status, failed.status].sort()).toEqual([200, 409]);
        const read = await request(e2e.http)
          .get('/api/v1/ci/releases/' + release.releaseId)
          .query({ repo: project.repo })
          .set(ci(project))
          .expect(200);
        expect(read.body).toMatchObject({
          verificationStatus: signed.status === 200 ? 'verified' : 'pending',
          deployments: [
            expect.objectContaining({
              status: signed.status === 200 ? 'pending' : 'failed',
            }),
          ],
        });
      }
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
      await attach(project, release, {
        ...signed,
        signature: { ...signed.signature, value: 'c2lnbmF0dXJl' },
      }).expect(400);
      await attach(project, release, {
        ...signed,
        signature: { ...signed.signature, keyId: 'unknown-release-key' },
      }).expect(403);

      const verified = await attach(project, release, signed).expect(200);
      expect(verified.body).toMatchObject({
        verificationStatus: 'verified',
        manifestSha256: signed.manifestSha256,
      });
      await attach(project, release, signed).expect(200);
      await attach(project, release, {
        ...signedManifest(project, release),
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
      const project = await releaseProject(['uat']);
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

      // dev is deployed by its workflow, so even dev's own host cannot see or
      // report it.
      await request(e2e.http)
        .post(
          '/api/v1/onprem/deployments/' +
            release.deployments[0]!.id +
            '/status',
        )
        .set(as(devHost.token))
        .send({ status: 'failed' })
        .expect(404);
    });

    it('refuses to promote to an environment without a target, then promotes once it has one', async () => {
      const project = await releaseProject(['uat', 'main']);
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

    it('creates an on-prem target as a record only, and keeps each environment delivered one way', async () => {
      const project = await releaseProject();
      const start = e2e.externalCalls.length;

      const created = await createTarget(
        project,
        onpremTarget(project.main),
      ).expect(201);
      expect(created.body).toMatchObject({
        provider: 'onprem-compose',
        providerProjectName: 'lab-api',
        environmentId: project.main,
        branchName: 'main',
      });

      await createTarget(project, onpremTarget(undefined)).expect(400);
      await createTarget(project, {
        ...onpremTarget(project.main),
        slot: 'frontend',
        ownershipMode: 'flowci_managed',
      }).expect(400);
      // uat already deploys a Render backend; an on-prem frontend would split it.
      await createTarget(project, {
        ...onpremTarget(project.uat),
        slot: 'frontend',
      }).expect(409);

      // The only write is the signing variable, so the host can verify releases.
      // No provider or workflow is called.
      expect(
        e2e.externalCalls
          .slice(start)
          .map(({ port, method, args }) => [port, method, args[3]]),
      ).toEqual([
        [
          'githubActions',
          'setActionsVariableStrict',
          'ALPHACI_RELEASE_KMS_KEY_VERSION',
        ],
      ]);
      expect(await onpremDiscovery(agent)).toMatchObject({ enabled: true });
    });

    it('promotes to an on-prem environment without a workflow, and only its host reports it', async () => {
      const project = await releaseProject();
      const release = await devRelease(project);
      const uat = (await promote(project, project.uat, release).expect(201))
        .body as Deployment;
      const reportCi = (deploymentId: string, status: string) =>
        request(e2e.http)
          .post('/api/v1/ci/deployments/' + deploymentId + '/status')
          .set(ci(project))
          .send({ repoFullName: project.repo, status });
      await reportCi(uat.id, 'deploying').expect(200);
      await reportCi(uat.id, 'healthy').expect(200);

      await createTarget(project, onpremTarget(project.main)).expect(201);
      const hostToken = await addHost(project, project.main);
      const start = e2e.externalCalls.length;

      const production = (
        await promote(project, project.main, release).expect(201)
      ).body as Deployment & { delivery: string };

      expect(production.delivery).toBe('host');
      expect(
        e2e.externalCalls
          .slice(start)
          .filter(({ method }) => method === 'dispatchWorkflow'),
      ).toEqual([]);
      const assignments = await request(e2e.http)
        .get('/api/v1/onprem/assignments')
        .set({ Authorization: 'Bearer ' + hostToken })
        .expect(200);
      expect(
        (assignments.body as Array<{ deploymentId: string }>).map(
          ({ deploymentId }) => deploymentId,
        ),
      ).toEqual([production.id]);

      await reportCi(production.id, 'deploying').expect(409);
      for (const value of ['deploying', 'healthy']) {
        await request(e2e.http)
          .post('/api/v1/onprem/deployments/' + production.id + '/status')
          .set({ Authorization: 'Bearer ' + hostToken })
          .send({ status: value })
          .expect(201);
      }
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

    it('enforces promotion and host setup personas through HTTP', async () => {
      const project = await releaseProject(['uat', 'main']);
      const release = await devRelease(project);
      try {
        for (const role of ['qa', 'member', 'lead']) {
          await e2e.query(
            'UPDATE identity.app_users SET app_role = $1 WHERE id = $2',
            [role, userId],
          );
          // QA cannot promote; members cannot promote to production. A lead
          // passes authorization but cannot skip the preceding environment.
          await promote(project, project.main, release).expect(
            role === 'lead' ? 409 : 403,
          );
          if (role === 'qa' || role === 'lead') {
            await agent
              .post(
                '/api/v1/projects/' +
                  project.projectId +
                  '/environments/' +
                  project.uat +
                  '/hosts',
              )
              .send({ name: 'refused-host' })
              .expect(403);
          }
        }
        await e2e.query(
          "UPDATE identity.app_users SET app_role = 'member' WHERE id = $1",
          [userId],
        );
        await promote(project, project.uat, release).expect(201);
      } finally {
        await e2e.query(
          "UPDATE identity.app_users SET app_role = 'admin' WHERE id = $1",
          [userId],
        );
      }
    });

    it("shows signed-in users their project's releases and deployments, and hides others'", async () => {
      const project = await releaseProject();
      const release = await devRelease(project);
      const promoted = (
        await promote(project, project.uat, release).expect(201)
      ).body as Deployment;

      const releases = await agent
        .get('/api/v1/projects/' + project.projectId + '/releases')
        .expect(200);
      expect(
        (releases.body as Release[]).map(({ releaseId }) => releaseId),
      ).toEqual([release.releaseId]);
      const history = await agent
        .get(
          '/api/v1/projects/' +
            project.projectId +
            '/environments/' +
            project.uat +
            '/deployments',
        )
        .expect(200);
      expect((history.body as Deployment[]).map(({ id }) => id)).toEqual([
        promoted.id,
      ]);

      const [other] = await e2e.query<{ id: string }>(
        'INSERT INTO identity.app_users (login, github_user_id) VALUES ($1, $1) RETURNING id',
        ['e2e-release-other-' + String(Date.now())],
      );
      const [foreign] = await e2e.query<{ id: string }>(
        `INSERT INTO projects.provisioned_projects
           (user_id, repo_full_name, template_id, service_name, workflow_path, status)
         VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
         RETURNING id`,
        [required(other).id, 'e2e-org/foreign-releases-' + String(Date.now())],
      );
      // Admins have global visibility; exercise owner isolation as a member.
      await e2e.query(
        "UPDATE identity.app_users SET app_role = 'member' WHERE id = $1",
        [userId],
      );
      await agent
        .get('/api/v1/projects/' + required(foreign).id + '/releases')
        .expect(404);
      await agent
        .get(
          '/api/v1/projects/' +
            required(foreign).id +
            '/environments/' +
            project.uat +
            '/deployments',
        )
        .expect(404);
      await request(e2e.http)
        .get('/api/v1/projects/' + project.projectId + '/releases')
        .expect(401);
      await e2e.query(
        "UPDATE identity.app_users SET app_role = 'admin' WHERE id = $1",
        [userId],
      );
    });
  });
});

function randomUuid(): string {
  return uuidFrom(randomBytes(16).toString('hex'));
}

/** What provider discovery advertises about on-prem hosts. */
async function onpremDiscovery(signedIn: SignedInAgent) {
  const response = await signedIn
    .get('/api/v1/deployment-providers')
    .expect(200);
  return (response.body as { providers: Array<{ id: string }> }).providers.find(
    ({ id }) => id === 'onprem-compose',
  );
}

function uuidFrom(hex: string): string {
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
