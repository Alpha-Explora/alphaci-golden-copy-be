import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labSigningKeyId } from '#kernel/config/release-signing-key';
import { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '#kernel/db/database.service';
import type { DeploymentProjectReferenceLookup } from '#kernel/ports/deployment-runtime.port';
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
});
