import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { DeploymentProvisioningRequestDto } from '../../api/dto/create-project.dto';
import {
  configureReleaseSigning,
  joinReleaseSigningWarnings,
  readLabSigningKey,
  RELEASE_SIGNING_SECRET,
  RELEASE_SIGNING_VARIABLE,
  withReleaseSigningWarning,
} from './release-signing.provisioning';

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';

const onpremRequest = {
  enabled: true,
  targets: [
    {
      slot: 'backend',
      provider: 'onprem-compose',
      ownershipMode: 'byo',
      environmentSlug: 'main',
    },
  ],
} as unknown as DeploymentProvisioningRequestDto;

const renderRequest = {
  enabled: true,
  targets: [
    { slot: 'backend', provider: 'render', ownershipMode: 'flowci_managed' },
  ],
} as unknown as DeploymentProvisioningRequestDto;

function ecPrivateKeyPem(namedCurve = 'prime256v1'): string {
  return generateKeyPairSync('ec', {
    namedCurve,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

function fakeSupport(env: Record<string, string | undefined> = {}) {
  return {
    githubService: {
      setActionsVariableStrict: jest.fn().mockResolvedValue(undefined),
      setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
    },
    configService: {
      get: (key: string) => env[key],
    } as unknown as ConfigService,
    workflowFragmentRegistry: {
      deliveredByHost: (provider: string) => provider === 'onprem-compose',
    },
  };
}

type FakeSupport = ReturnType<typeof fakeSupport>;

function configure(
  support: FakeSupport,
  request: DeploymentProvisioningRequestDto | undefined,
) {
  return configureReleaseSigning(support as never, {
    accessToken: 'provisioning-token',
    owner: 'acme',
    repo: 'orders',
    request,
  });
}

describe('configureReleaseSigning', () => {
  let tempDir: string;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'release-signing-'));
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('when the request has no on-prem target', () => {
    it.each([
      { name: 'no deployment request', request: undefined },
      {
        name: 'deployment disabled',
        request: { ...onpremRequest, enabled: false },
      },
      { name: 'only a Render target', request: renderRequest },
    ])('writes nothing for $name', async ({ request }) => {
      const support = fakeSupport({
        ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
      });

      await expect(configure(support, request)).resolves.toBeUndefined();

      expect(
        support.githubService.setActionsVariableStrict,
      ).not.toHaveBeenCalled();
      expect(
        support.githubService.setActionsSecretStrict,
      ).not.toHaveBeenCalled();
    });
  });

  describe('when the request has an on-prem target', () => {
    it('branch 1: sets the Cloud KMS key version as a repository variable', async () => {
      const support = fakeSupport({
        ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
      });

      await expect(configure(support, onpremRequest)).resolves.toBeUndefined();

      expect(
        support.githubService.setActionsVariableStrict,
      ).toHaveBeenCalledWith(
        'provisioning-token',
        'acme',
        'orders',
        RELEASE_SIGNING_VARIABLE,
        KEY_VERSION,
      );
      expect(
        support.githubService.setActionsSecretStrict,
      ).not.toHaveBeenCalled();
    });

    it('branch 2: sets the lab key as a repository secret when only the lab key path is configured', async () => {
      const pem = ecPrivateKeyPem();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pem);
      const support = fakeSupport({ ONPREM_LAB_SIGNING_KEY_PATH: keyPath });

      await expect(configure(support, onpremRequest)).resolves.toBeUndefined();

      expect(support.githubService.setActionsSecretStrict).toHaveBeenCalledWith(
        'provisioning-token',
        'acme',
        'orders',
        RELEASE_SIGNING_SECRET,
        pem,
      );
      expect(
        support.githubService.setActionsVariableStrict,
      ).not.toHaveBeenCalled();
    });

    it('branch 3: returns a warning and writes nothing when no signing is configured', async () => {
      const support = fakeSupport();

      const warning = await configure(support, onpremRequest);

      expect(warning).toContain('Releases cannot be signed yet');
      expect(warning).toContain('ALPHACI_RELEASE_KMS_KEY_VERSION');
      expect(
        support.githubService.setActionsVariableStrict,
      ).not.toHaveBeenCalled();
      expect(
        support.githubService.setActionsSecretStrict,
      ).not.toHaveBeenCalled();
    });

    it('warns, and does not fall back to the lab key, when the KMS value is malformed', async () => {
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, ecPrivateKeyPem());
      const support = fakeSupport({
        ALPHACI_RELEASE_KMS_KEY_VERSION: 'release-signing',
        ONPREM_LAB_SIGNING_KEY_PATH: keyPath,
      });

      const warning = await configure(support, onpremRequest);

      expect(warning).toContain('not a full Cloud KMS key version name');
      expect(
        support.githubService.setActionsVariableStrict,
      ).not.toHaveBeenCalled();
      expect(
        support.githubService.setActionsSecretStrict,
      ).not.toHaveBeenCalled();
    });

    it('returns a warning, without throwing, when GitHub refuses the variable', async () => {
      const support = fakeSupport({
        ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
      });
      support.githubService.setActionsVariableStrict.mockRejectedValueOnce(
        new Error('Resource not accessible by integration'),
      );

      const warning = await configure(support, onpremRequest);

      expect(warning).toContain('acme/orders');
      expect(warning).toContain('Resource not accessible by integration');
      expect(warning).toContain(
        `the repository variable ${RELEASE_SIGNING_VARIABLE}`,
      );
    });

    it('never puts the lab key into a warning or a log line', async () => {
      const pem = ecPrivateKeyPem();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pem);
      const support = fakeSupport({ ONPREM_LAB_SIGNING_KEY_PATH: keyPath });
      support.githubService.setActionsSecretStrict.mockRejectedValueOnce(
        new Error('GitHub 502'),
      );
      const keyBody = pem.split('\n')[1] ?? pem;

      const warning = await configure(support, onpremRequest);

      expect(warning).toContain('GitHub 502');
      expect(warning).not.toContain(keyBody);
      const logged = warn.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('GitHub 502');
      expect(logged).not.toContain(keyBody);
    });

    it('warns with the setting name when the lab key file is missing', async () => {
      const support = fakeSupport({
        ONPREM_LAB_SIGNING_KEY_PATH: join(tempDir, 'absent.key'),
      });

      const warning = await configure(support, onpremRequest);

      expect(warning).toContain(
        'ONPREM_LAB_SIGNING_KEY_PATH points to a file that cannot be read',
      );
      expect(
        support.githubService.setActionsSecretStrict,
      ).not.toHaveBeenCalled();
    });
  });
});

describe('readLabSigningKey', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lab-signing-key-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the PEM of a P-256 private key unchanged', async () => {
    const pem = ecPrivateKeyPem();
    const keyPath = join(tempDir, 'key.pem');
    writeFileSync(keyPath, pem);

    await expect(readLabSigningKey(keyPath)).resolves.toBe(pem);
  });

  it('rejects a private key on another curve, naming the setting only', async () => {
    const keyPath = join(tempDir, 'p384.pem');
    writeFileSync(keyPath, ecPrivateKeyPem('secp384r1'));

    await expect(readLabSigningKey(keyPath)).rejects.toThrow(
      'ONPREM_LAB_SIGNING_KEY_PATH must contain a P-256 private key',
    );
  });

  it('rejects content that is not a PEM private key without echoing it', async () => {
    const keyPath = join(tempDir, 'garbage.pem');
    writeFileSync(keyPath, 'not-a-key-SECRET-MATERIAL');

    const error = await readLabSigningKey(keyPath).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'does not contain a PEM private key',
    );
    expect((error as Error).message).not.toContain('SECRET-MATERIAL');
  });
});

describe('warning helpers', () => {
  it('adds releaseSigningWarning only when there is a warning', () => {
    expect(withReleaseSigningWarning({ id: 'p1' }, undefined)).toEqual({
      id: 'p1',
    });
    expect(withReleaseSigningWarning({ id: 'p1' }, 'Set it.')).toEqual({
      id: 'p1',
      releaseSigningWarning: 'Set it.',
    });
  });

  it('joins per-repository warnings and drops absent ones', () => {
    expect(joinReleaseSigningWarnings(undefined, undefined)).toBeUndefined();
    expect(joinReleaseSigningWarnings(undefined, 'Frontend.')).toBe(
      'Frontend.',
    );
    expect(joinReleaseSigningWarnings('Backend.', 'Frontend.')).toBe(
      'Backend. Frontend.',
    );
  });
});
