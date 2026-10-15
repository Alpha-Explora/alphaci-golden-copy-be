import { execFile, execFileSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

import request from 'supertest';

import { canonicalJson } from '../../src/modules/runtime/domain/release-manifest';
import {
  startApplication,
  type E2eApplication,
  type SignedInAgent,
} from './support/application';
import { required } from './support/database';

const AGENT_DIR = resolve(__dirname, '..', '..', 'deploy', 'onprem', 'agent');
const IMAGE = 'alphaci-agent-e2e:1';
const TRUSTED_KEY_ID = 'projects/e2e/keys/release/1';
const OTHER_KEY_ID = 'projects/e2e/keys/release/2';
const previousTrustKeys = process.env['ALPHACI_RELEASE_TRUST_KEYS_JSON'];
const previousOnpremFlag = process.env['ONPREM_RELEASES_ENABLED'];
const DOCKER_STUB = [
  '#!/usr/bin/env bash',
  '# Records every docker call; fails compose for an env file naming FAIL_DIGEST,',
  '# and every pull when FAIL_PULL is set.',
  'echo "$*" >> /work/docker.log',
  'if [ "$1" = pull ] && [ -n "${FAIL_PULL:-}" ]; then exit 1; fi',
  'if [ "$1" = compose ] && [ -n "${FAIL_DIGEST:-}" ]; then',
  '  for argument in "$@"; do',
  '    if [ -f "$argument" ] && grep -q "$FAIL_DIGEST" "$argument"; then exit 1; fi',
  '  done',
  'fi',
  'exit 0',
  '',
].join('\n');

const digest = (character: string) => 'sha256:' + character.repeat(64);

/**
 * The on-prem host agent against the real release API, run in a Linux
 * container with Docker replaced by a recording stub. Failure modes: an
 * image pulled before the signature is checked; a release signed with another
 * key, or a changed manifest, deployed; an image pulled by tag; a release that
 * fails its health check left running, or reported healthy; the previous
 * release not restored; a support bundle that leaks the host token or lacks
 * what support needs.
 */
describe('On-prem host agent', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let userId: string;
  let port: number;
  let work: string;
  let healthServer: ReturnType<typeof createServer>;
  let healthPort: number;
  let healthResponses: number[] = [];
  let healthRequests = 0;
  let project: {
    id: string;
    repo: string;
    token: string;
    dev: string;
    prod: string;
    hostToken: string;
  };
  const trusted = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let run = 0;

  const ci = () => ({ Authorization: 'Bearer ' + project.token });

  async function release(
    character: string,
    key: KeyObject,
    keyId = TRUSTED_KEY_ID,
  ): Promise<string> {
    run += 1;
    const workflowRun = {
      provider: 'github_actions',
      repo: project.repo,
      runId: String(Date.now()) + String(run),
      url:
        'https://github.com/' + project.repo + '/actions/runs/' + String(run),
    };
    const registered = await request(e2e.http)
      .post('/api/v1/ci/releases')
      .set(ci())
      .send({
        repoFullName: project.repo,
        sourceEnvironmentId: project.dev,
        sourceBranch: 'dev',
        commitSha: character.repeat(40),
        artifacts: [
          {
            slot: 'backend',
            reference: 'ghcr.io/e2e-org/api@' + digest(character),
          },
        ],
        workflowRun,
      })
      .expect(202);
    const body = registered.body as { releaseId: string; createdAt: string };
    const manifest = {
      schemaVersion: 1,
      releaseId: body.releaseId,
      projectId: project.id,
      sourceEnvironmentId: project.dev,
      sourceBranch: 'dev',
      commitSha: character.repeat(40),
      createdAt: body.createdAt,
      artifacts: [
        {
          slot: 'backend',
          image: 'ghcr.io/e2e-org/api',
          digest: digest(character),
        },
      ],
      workflowRun,
    };
    const canonical = canonicalJson(manifest);
    await request(e2e.http)
      .put('/api/v1/ci/releases/' + body.releaseId + '/manifest')
      .set(ci())
      .send({
        repoFullName: project.repo,
        manifest,
        manifestSha256: createHash('sha256').update(canonical).digest('hex'),
        signature: {
          algorithm: 'ecdsa-p256-sha256',
          keyId,
          value: sign('sha256', Buffer.from(canonical), key).toString('base64'),
        },
      })
      .expect(200);
    for (const status of ['deploying', 'healthy']) {
      await request(e2e.http)
        .post('/api/v1/ci/releases/' + body.releaseId + '/deployment-status')
        .set(ci())
        .send({ repoFullName: project.repo, status })
        .expect(200);
    }
    return body.releaseId;
  }

  async function promoteToProduction(releaseId: string): Promise<string> {
    const promoted = await agent
      .post(
        '/api/v1/projects/' +
          project.id +
          '/environments/' +
          project.prod +
          '/promotions',
      )
      .send({ releaseId })
      .expect(201);
    return (promoted.body as { id: string }).id;
  }

  // Asynchronous: the agent calls back into this process's HTTP server.
  async function runAgent(extra: string[] = [], command = '') {
    writeFileSync(join(work, 'docker.log'), '');
    await promisify(execFile)(
      'docker',
      [
        'run',
        '--rm',
        '--add-host=host.docker.internal:host-gateway',
        '-v',
        AGENT_DIR + ':/agent:ro',
        '-v',
        work + ':/work',
        '-e',
        'ALPHACI_AGENT_CONFIG=/nonexistent',
        '-e',
        'ALPHACI_API_URL=http://host.docker.internal:' + String(port),
        '-e',
        'ALPHACI_HOST_TOKEN_FILE=/work/token',
        '-e',
        'ALPHACI_TRUST_KEY=/work/trust.pem',
        '-e',
        'ALPHACI_COMPOSE_FILE=/work/compose.yaml',
        '-e',
        'ALPHACI_STATE_DIR=/work/state',
        '-e',
        'ALPHACI_DOCKER=/work/docker',
        '-e',
        'ALPHACI_HEALTH_TIMEOUT=5',
        '-e',
        'ALPHACI_SUPPORT_DIR=/work/support',
        ...extra,
        IMAGE,
        'sh',
        '-c',
        'chmod +x /work/docker /work/bin/curl && PATH=/work/bin:$PATH bash /agent/alphaci-agent.sh ' +
          command,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    return readFileSync(join(work, 'docker.log'), 'utf8');
  }

  async function status(deploymentId: string) {
    const [row] = await e2e.query<{ status: string }>(
      'SELECT status FROM env_provisioning.environment_deployments WHERE id = $1',
      [deploymentId],
    );
    return required(row).status;
  }

  beforeAll(async () => {
    execFileSync('docker', ['build', '-t', IMAGE, '-'], {
      input:
        'FROM alpine:3.20\nRUN apk add --no-cache bash jq openssl curl coreutils\n',
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    process.env['ONPREM_RELEASES_ENABLED'] = 'true';
    process.env['ALPHACI_RELEASE_TRUST_KEYS_JSON'] = JSON.stringify({
      [TRUSTED_KEY_ID]: trusted.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      [OTHER_KEY_ID]: other.publicKey.export({ type: 'spki', format: 'pem' }),
    });
    e2e = await startApplication();
    port = await e2e.listen();
    ({ agent, userId } = await e2e.signIn('admin'));

    const repo = 'e2e-org/agent-' + String(Date.now());
    const [row] = await e2e.query<{ id: string }>(
      `INSERT INTO projects.provisioned_projects
         (user_id, repo_full_name, template_id, service_name, workflow_path, status)
       VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
       RETURNING id`,
      [userId, repo],
    );
    const projectId = required(row).id;
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
    const prod = await environment('main', 1, 'production');
    // dev deploys through its workflow; production is the on-prem host's.
    for (const [environmentId, branch, provider, ownership, strategy] of [
      [dev, 'dev', 'render', 'flowci_managed', 'render_image_pushed'],
      [prod, 'main', 'onprem-compose', 'byo', 'provider_native'],
    ] as const) {
      await e2e.query(
        `INSERT INTO env_provisioning.project_deployment_targets
           (project_id, environment_id, slot, ownership_mode, provider, provider_project_id,
            provider_project_name, repo_full_name, branch_name, deployment_strategy)
         VALUES ($1, $2, 'backend', $6, $7, $3, $3, $4, $5, $8)`,
        [
          projectId,
          environmentId,
          repo + '-' + branch,
          repo,
          branch,
          ownership,
          provider,
          strategy,
        ],
      );
    }
    const token = 'e2e_ci_' + randomBytes(16).toString('hex');
    await e2e.query(
      "INSERT INTO ci.project_ci_tokens (project_id, token_hash, token_prefix, status) VALUES ($1, $2, $3, 'active')",
      [
        projectId,
        createHash('sha256').update(token).digest('hex'),
        token.slice(0, 10),
      ],
    );
    const host = await agent
      .post(
        '/api/v1/projects/' + projectId + '/environments/' + prod + '/hosts',
      )
      .send({ name: 'lab' })
      .expect(201);
    project = {
      id: projectId,
      repo,
      token,
      dev,
      prod,
      hostToken: (host.body as { token: string }).token,
    };

    work = mkdtempSync(join(tmpdir(), 'alphaci-agent-'));
    writeFileSync(join(work, 'token'), project.hostToken);
    writeFileSync(
      join(work, 'trust.pem'),
      trusted.publicKey.export({ type: 'spki', format: 'pem' }),
    );
    writeFileSync(join(work, 'compose.yaml'), 'services: {}\n');
    writeFileSync(join(work, 'docker'), DOCKER_STUB);
    mkdirSync(join(work, 'bin'));
    // Keep real HTTP status checks, but omit retry delays for the scripted
    // health endpoint. API calls retain the agent's actual curl arguments.
    writeFileSync(
      join(work, 'bin', 'curl'),
      [
        '#!/usr/bin/env bash',
        'if [ -n "${ALPHACI_HEALTH_URL:-}" ] && [ "${!#}" = "$ALPHACI_HEALTH_URL" ]; then',
        '  exec /usr/bin/curl -fsS --max-time 2 "$ALPHACI_HEALTH_URL"',
        'fi',
        'exec /usr/bin/curl "$@"',
        '',
      ].join('\n'),
    );
    healthServer = createServer((_request, response) => {
      healthRequests += 1;
      response.writeHead(healthResponses.shift() ?? 503).end();
    });
    await new Promise<void>((resolve) =>
      healthServer.listen(0, '0.0.0.0', resolve),
    );
    const address = healthServer.address();
    if (!address || typeof address === 'string')
      throw new Error('No health port');
    healthPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      healthServer?.close((error) => (error ? reject(error) : resolve())),
    );
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
  });

  it('deploys a signed release by digest and reports it healthy', async () => {
    const deploymentId = await promoteToProduction(
      await release('a', trusted.privateKey),
    );

    const log = await runAgent();

    expect(await status(deploymentId)).toBe('healthy');
    expect(log).toContain('pull ghcr.io/e2e-org/api@' + digest('a'));
    expect(log).toContain(
      'compose -p alphaci -f /work/compose.yaml --env-file /work/state/' +
        deploymentId +
        '.env up -d --wait',
    );
    expect(readFileSync(join(work, 'state', 'current.env'), 'utf8')).toContain(
      'ALPHACI_IMAGE_BACKEND=ghcr.io/e2e-org/api@' + digest('a'),
    );
  });

  it('refuses a release signed with another key and pulls nothing', async () => {
    const deploymentId = await promoteToProduction(
      await release('b', other.privateKey, OTHER_KEY_ID),
    );

    const log = await runAgent();

    expect(await status(deploymentId)).toBe('failed');
    expect(log).toBe('');
    expect(readFileSync(join(work, 'state', 'current.env'), 'utf8')).toContain(
      digest('a'),
    );
  });

  it('restores the previous release when the new one fails its health check', async () => {
    const deploymentId = await promoteToProduction(
      await release('c', trusted.privateKey),
    );

    const log = await runAgent(['-e', 'FAIL_DIGEST=' + digest('c')]);

    expect(await status(deploymentId)).toBe('rolled_back');
    const composeCalls = log
      .split('\n')
      .filter((line) => line.startsWith('compose'));
    expect(composeCalls).toEqual([
      expect.stringContaining('/work/state/' + deploymentId + '.env up'),
      expect.stringContaining('/work/state/current.env up'),
    ]);
    expect(readFileSync(join(work, 'state', 'current.env'), 'utf8')).toContain(
      digest('a'),
    );
  });

  it('reports a failed pull as failed and leaves the running release alone', async () => {
    const deploymentId = await promoteToProduction(
      await release('d', trusted.privateKey),
    );

    const log = await runAgent(['-e', 'FAIL_PULL=1']);

    expect(await status(deploymentId)).toBe('failed');
    expect(log).toContain('pull ghcr.io/e2e-org/api@' + digest('d'));
    expect(log.split('\n').some((line) => line.startsWith('compose'))).toBe(
      false,
    );
    expect(readFileSync(join(work, 'state', 'current.env'), 'utf8')).toContain(
      digest('a'),
    );
  });

  it.each([
    ['healthy', [503, 200], 'rolled_back'],
    ['unhealthy', [503, 503], 'failed'],
  ] as const)(
    'checks the restored app over HTTP when it is %s',
    async (_case, responses, expectedStatus) => {
      const deploymentId = await promoteToProduction(
        await release('e', trusted.privateKey),
      );
      healthResponses = [...responses];
      healthRequests = 0;

      const log = await runAgent([
        '-e',
        'ALPHACI_HEALTH_URL=http://host.docker.internal:' + String(healthPort),
      ]);

      expect(await status(deploymentId)).toBe(expectedStatus);
      expect(healthRequests).toBe(2);
      expect(
        log.split('\n').filter((line) => line.startsWith('compose')),
      ).toEqual([
        expect.stringContaining('/work/state/' + deploymentId + '.env up'),
        expect.stringContaining('/work/state/current.env up'),
      ]);
      expect(
        readFileSync(join(work, 'state', 'current.env'), 'utf8'),
      ).toContain(digest('a'));
    },
  );

  it('writes a support bundle with the running release and none of the host token', async () => {
    const log = await runAgent([], 'support-bundle');

    // The bundle asked Compose for state and logs, and pulled or started nothing.
    const calls = log.split('\n').filter(Boolean);
    expect(calls).toEqual([
      'version --format docker {{.Server.Version}}',
      expect.stringMatching(/current\.env ps -a$/),
      expect.stringMatching(
        /current\.env logs --no-color --timestamps --tail 200$/,
      ),
    ]);

    await promisify(execFile)('docker', [
      'run',
      '--rm',
      '-v',
      work + ':/work',
      IMAGE,
      'sh',
      '-c',
      'rm -rf /work/bundle && mkdir /work/bundle && tar -xzf /work/support/*.tar.gz -C /work/bundle',
    ]);
    const files = listFiles(join(work, 'bundle'));
    const text = (name: string) =>
      readFileSync(required(files.find((file) => file.endsWith(name))), 'utf8');

    expect(text('release.env')).toContain(
      'ALPHACI_IMAGE_BACKEND=ghcr.io/e2e-org/api@' + digest('a'),
    );
    expect(text('settings.txt')).toContain(
      'ALPHACI_HOST_TOKEN_FILE=<redacted>',
    );
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toContain(project.hostToken);
    }
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
