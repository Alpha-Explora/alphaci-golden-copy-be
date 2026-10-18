import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labSigningKeyId } from '#kernel/config/release-signing-key';
import { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '#kernel/db/database.service';
import type { DeploymentProjectReferenceLookup } from '#kernel/ports/deployment-runtime.port';
import { UPDATE_AGENT_MESSAGE } from '../../domain/onprem-tunnel';
import { createReleaseSigner } from '../../infrastructure/release-signing/release-signer';
import { OnpremReadinessService } from './onprem-readiness.service';

describe('On-prem readiness', () => {
  const query = jest.fn();
  const projects = {
    findProjectReference: jest.fn(),
    findProjectEnvironment: jest.fn(),
  };
  const config = new ConfigService({
    PLATFORM_PUBLIC_URL: 'https://api.example.com',
    ONPREM_RELEASES_ENABLED: 'true',
  });
  const service = () =>
    new OnpremReadinessService(
      { query } as unknown as DatabaseService,
      projects as unknown as DeploymentProjectReferenceLookup,
      config,
    );
  beforeEach(() => {
    jest.clearAllMocks();
    projects.findProjectReference.mockResolvedValue({ projectId: 'project' });
    projects.findProjectEnvironment.mockResolvedValue({ id: 'env' });
    query.mockResolvedValue({
      rows: [{ releases: 'releases', hosts: 'hosts', active_host_index: null }],
    });
  });
  it('checks actual schema without DDL and keeps credentials/registry unverified', async () => {
    const result = await service().read('project', 'env', 'viewer');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'schema', status: 'failed' }),
        expect.objectContaining({
          id: 'ci-signing-secret',
          status: 'unverified',
        }),
        expect.objectContaining({ id: 'registry', status: 'unverified' }),
      ]),
    );
    expect(
      query.mock.calls.every(([sql]: [string]) => /^\s*SELECT/.test(sql)),
    ).toBe(true);
  });
  it('checks visibility before inspecting schema', async () => {
    projects.findProjectReference.mockResolvedValue(null);
    await expect(
      service().read('project', 'env', 'other'),
    ).rejects.toMatchObject({ status: 404 });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { fresh: true, revoked: false, expected: 'passed' },
    { fresh: false, revoked: false, expected: 'failed' },
    { fresh: true, revoked: true, expected: 'failed' },
  ])(
    'keeps application health unverified for machine $expected (fresh=$fresh, revoked=$revoked)',
    async ({ fresh, revoked, expected }) => {
      projects.findProjectEnvironment.mockResolvedValue({
        id: 'env',
        role: 'production',
      });
      query
        .mockResolvedValueOnce({
          rows: [
            {
              releases: 'releases',
              hosts: 'hosts',
              active_host_index: true,
              machine_schema: true,
              tunnel_schema: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              machine_id: 'machine',
              fresh,
              revoked,
              checks: [
                {
                  id: 'docker',
                  status: 'passed',
                  message: 'Docker and Compose available.',
                },
              ],
              assignment_config: {
                ports: [
                  { slot: 'frontend', hostPort: 8080, containerPort: 3000 },
                ],
                health: [{ slot: 'frontend', path: null }],
                ingress: { mode: 'direct', publicUrl: null },
              },
            },
          ],
        });
      const result = await service().read('project', 'env', 'viewer');
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'host', status: expected }),
          expect.objectContaining({ id: 'health-paths', status: 'failed' }),
          expect.objectContaining({ id: 'ingress', status: 'failed' }),
          expect.objectContaining({
            id: 'application-health',
            status: 'unverified',
          }),
        ]),
      );
    },
  );

  describe('automatic HTTPS address (tunnel) ingress', () => {
    const ingress = (
      role: 'production' | 'non_production',
      report: Record<string, unknown>,
    ) => {
      projects.findProjectEnvironment.mockResolvedValue({ id: 'env', role });
      query
        .mockResolvedValueOnce({
          rows: [
            {
              releases: 'releases',
              hosts: 'hosts',
              active_host_index: true,
              machine_schema: true,
              tunnel_schema: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              machine_id: 'machine',
              fresh: true,
              revoked: false,
              checks: [{ id: 'docker', status: 'passed', message: 'Docker.' }],
              assignment_config: {
                ports: [
                  { slot: 'frontend', hostPort: 8080, containerPort: 3000 },
                ],
                health: [{ slot: 'frontend', path: '/' }],
                ingress: { mode: 'tunnel', publicUrl: null },
              },
              agent_version: '0.3.0',
              tunnel_status: null,
              tunnel_url: null,
              tunnel_message: null,
              tunnel_reported_at: null,
              tunnel_fresh: false,
              ...report,
            },
          ],
        });
      return service().read('project', 'env', 'viewer');
    };
    const reportedAt = new Date();
    it('passes ingress for production once the machine reports an HTTPS address', async () => {
      const result = await ingress('production', {
        tunnel_status: 'running',
        tunnel_url: 'https://quiet-fox-blue.trycloudflare.com',
        tunnel_message: 'Ready.',
        tunnel_reported_at: reportedAt,
        tunnel_fresh: true,
      });
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: 'ingress',
          status: 'unverified',
          message: expect.stringContaining(
            'https://quiet-fox-blue.trycloudflare.com',
          ),
        }),
      );
    });
    it('fails production until a report arrives, then shows the plain reason from the machine', async () => {
      const waiting = await ingress('production', {});
      expect(waiting.checks).toContainEqual(
        expect.objectContaining({
          id: 'ingress',
          status: 'failed',
          message:
            'Waiting for the HTTPS address. Production is not deployed until the machine reports one.',
        }),
      );
      const unavailable = await ingress('production', {
        tunnel_status: 'unavailable',
        tunnel_message: 'cloudflared is not installed on this machine.',
        tunnel_reported_at: reportedAt,
        tunnel_fresh: true,
      });
      expect(unavailable.checks).toContainEqual(
        expect.objectContaining({
          id: 'ingress',
          status: 'failed',
          message:
            'Waiting for the HTTPS address. cloudflared is not installed on this machine.',
        }),
      );
    });
    it('asks for an agent update when the machine runs an agent without tunnels', async () => {
      const result = await ingress('production', { agent_version: '0.2.0' });
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: 'ingress',
          status: 'failed',
          message: `Waiting for the HTTPS address. ${UPDATE_AGENT_MESSAGE}`,
        }),
      );
    });
    it('treats a stale report as waiting', async () => {
      const result = await ingress('non_production', {
        tunnel_status: 'running',
        tunnel_url: 'https://quiet-fox-blue.trycloudflare.com',
        tunnel_reported_at: reportedAt,
        tunnel_fresh: false,
      });
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id: 'ingress', status: 'failed' }),
      );
    });
  });

  describe('release-signing check', () => {
    const KEY_VERSION =
      'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';
    const SIGNER_ENV = {
      ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER:
        'projects/123456789/locations/global/workloadIdentityPools/alphaci-release/providers/github',
      ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT:
        'release-signer@alphaci-prod.iam.gserviceaccount.com',
    };
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'readiness-signing-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    const keyPair = () =>
      generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

    const signingCheck = async (env: Record<string, string>) => {
      const withEnv = new OnpremReadinessService(
        { query } as unknown as DatabaseService,
        projects as unknown as DeploymentProjectReferenceLookup,
        new ConfigService({
          PLATFORM_PUBLIC_URL: 'https://api.example.com',
          ONPREM_RELEASES_ENABLED: 'true',
          ...env,
        }),
      );
      const result = await withEnv.read('project', 'env', 'viewer');
      return result.checks.find((item) => item.id === 'release-signing');
    };

    it('fails in plain language when neither Cloud KMS nor a lab key is configured', async () => {
      await expect(signingCheck({})).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining(
          'Releases cannot be signed: configure Cloud KMS',
        ),
      });
    });

    it('passes with Cloud KMS when the signer is complete and the key version is trusted', async () => {
      const { publicKey } = keyPair();

      await expect(
        signingCheck({
          ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
          ...SIGNER_ENV,
          ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({
            [KEY_VERSION]: publicKey,
          }),
        }),
      ).resolves.toMatchObject({
        status: 'passed',
        message: expect.stringContaining('Cloud KMS'),
      });
    });

    it('fails when the Cloud KMS key version is not in the trust setting', async () => {
      await expect(
        signingCheck({
          ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
          ...SIGNER_ENV,
          ALPHACI_RELEASE_TRUST_KEYS_JSON: '{}',
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining(KEY_VERSION),
      });
    });

    it('fails when the Cloud KMS signer is incomplete, without a lab fallback', async () => {
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, keyPair().privateKey);

      await expect(
        signingCheck({
          ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
          ONPREM_LAB_SIGNING_KEY_PATH: keyPath,
          ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER:
            SIGNER_ENV.ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER,
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining(
          'ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT must be set',
        ),
      });
    });

    it('fails when the Cloud KMS value is not a full key-version name', async () => {
      await expect(
        signingCheck({
          ALPHACI_RELEASE_KMS_KEY_VERSION: 'release-signing',
          ...SIGNER_ENV,
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining(
          'must be a full Cloud KMS key version name',
        ),
      });
    });

    it('passes with the lab key when its key ID is trusted, and says it is lab-only', async () => {
      const pair = keyPair();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pair.privateKey);

      await expect(
        signingCheck({
          ONPREM_LAB_SIGNING_KEY_PATH: keyPath,
          ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({
            [labSigningKeyId(pair.privateKey)]: pair.publicKey,
          }),
        }),
      ).resolves.toMatchObject({
        status: 'passed',
        message: expect.stringContaining('Lab hosts only'),
      });
    });

    it('fails with the lab key ID when the lab key is not trusted', async () => {
      const pair = keyPair();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pair.privateKey);

      await expect(
        signingCheck({ ONPREM_LAB_SIGNING_KEY_PATH: keyPath }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining(labSigningKeyId(pair.privateKey)),
      });
    });

    it('fails when the lab key file cannot be read', async () => {
      await expect(
        signingCheck({
          ONPREM_LAB_SIGNING_KEY_PATH: join(tempDir, 'absent.key'),
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('The lab signing key cannot be used'),
      });
    });
  });

  describe('file release signer', () => {
    let fileDir: string;
    let fileKeyPath: string;

    beforeAll(() => {
      fileDir = mkdtempSync(join(tmpdir(), 'readiness-file-signer-'));
      const pair = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      fileKeyPath = join(fileDir, 'sign.key');
      writeFileSync(fileKeyPath, pair.privateKey);
    });
    afterAll(() => {
      rmSync(fileDir, { recursive: true, force: true });
    });

    const fileEnv = (keyPath: string) => ({
      ALPHACI_RELEASE_SIGNER: 'file',
      ALPHACI_RELEASE_SIGNING_KEY_FILE: keyPath,
    });
    const readFileCheck = async (env: Record<string, string>) => {
      const signer = createReleaseSigner((key) => env[key]);
      const withSigner = new OnpremReadinessService(
        { query } as unknown as DatabaseService,
        projects as unknown as DeploymentProjectReferenceLookup,
        new ConfigService({
          PLATFORM_PUBLIC_URL: 'https://api.example.com',
          ONPREM_RELEASES_ENABLED: 'true',
          ...env,
        }),
        signer,
      );
      return (await withSigner.read('project', 'env', 'viewer')).checks;
    };

    it('passes with the backend signer, trusts its key with no trust setting, and drops the CI signing secret', async () => {
      const checks = await readFileCheck(fileEnv(fileKeyPath));
      const find = (id: string) => checks.find((item) => item.id === id);
      expect(find('release-signing')).toMatchObject({
        status: 'passed',
        message: expect.stringContaining(
          'signed by this AlphaCI backend with key ' +
            labSigningKeyId(readFileSync(fileKeyPath, 'utf8')),
        ),
      });
      expect(find('signing-trust')).toMatchObject({ status: 'passed' });
      expect(find('ci-signing-secret')).toMatchObject({ status: 'passed' });
    });

    it('fails with the signer problem when the key file cannot be used', async () => {
      const env = fileEnv(join(fileDir, 'absent.key'));
      const checks = await readFileCheck(env);
      expect(
        checks.find((item) => item.id === 'release-signing'),
      ).toMatchObject({
        status: 'failed',
        message: expect.stringContaining('cannot be read'),
      });
    });

    it('fails when the mode is unknown or file mode names no key', async () => {
      await expect(
        readFileCheck({ ALPHACI_RELEASE_SIGNER: 'kms' }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'release-signing',
            status: 'failed',
            message: expect.stringContaining('must be runner or file'),
          }),
        ]),
      );
      await expect(
        readFileCheck({ ALPHACI_RELEASE_SIGNER: 'file' }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'release-signing',
            status: 'failed',
            message: expect.stringContaining(
              'ALPHACI_RELEASE_SIGNING_KEY_FILE',
            ),
          }),
        ]),
      );
    });
  });
});
