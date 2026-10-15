import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { labSigningKeyId } from '#kernel/config/release-signing-key';
import {
  RELEASE_SIGNING_SECRET,
  RELEASE_SIGNING_VARIABLE,
} from '#kernel/config/release-signing-provisioning';
import {
  configureReleaseSigning,
  withReleaseSigningWarning,
} from './release-signing.provisioning';

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';
const SIGNER_PROVIDER =
  'projects/123456789/locations/global/workloadIdentityPools/alphaci-release/providers/github';
const SIGNER_ACCOUNT = 'release-signer@alphaci-prod.iam.gserviceaccount.com';

const onprem = [{ slot: 'backend', provider: 'onprem-compose' }];
const render = [{ slot: 'backend', provider: 'render' }];

function keyPair(namedCurve = 'prime256v1') {
  return generateKeyPairSync('ec', {
    namedCurve,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function kmsEnv(trustKeys: Record<string, string> = {}) {
  return {
    ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
    ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER: SIGNER_PROVIDER,
    ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT: SIGNER_ACCOUNT,
    ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify(trustKeys),
  };
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
  targets: readonly { provider: string }[],
) {
  return configureReleaseSigning(support as never, {
    accessToken: 'provisioning-token',
    owner: 'acme',
    repo: 'orders',
    targets,
  });
}

function expectNoWrites(support: FakeSupport) {
  expect(support.githubService.setActionsVariableStrict).not.toHaveBeenCalled();
  expect(support.githubService.setActionsSecretStrict).not.toHaveBeenCalled();
}

describe('configureReleaseSigning', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('when no target is host-delivered', () => {
    it.each([
      { name: 'no targets', targets: [] },
      { name: 'only a Render target', targets: render },
    ])('writes nothing for $name', async ({ targets }) => {
      const support = fakeSupport(kmsEnv());

      await expect(configure(support, targets)).resolves.toBeUndefined();

      expectNoWrites(support);
    });
  });

  describe('when any target is host-delivered', () => {
    it('configures when on-prem sits alongside hosted targets, because a host consumes the release every environment shares', async () => {
      const support = fakeSupport(kmsEnv());

      await configure(support, [...render, ...onprem]);

      expect(
        support.githubService.setActionsVariableStrict,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cloud KMS', () => {
    it('sets the key version variable and reports nothing when the key version is trusted', async () => {
      const pair = keyPair();
      const support = fakeSupport(kmsEnv({ [KEY_VERSION]: pair.publicKey }));

      await expect(configure(support, onprem)).resolves.toBeUndefined();

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

    it('still sets the variable but warns when the key version is not in the trust setting', async () => {
      const support = fakeSupport(kmsEnv({}));

      const warning = await configure(support, onprem);

      expect(
        support.githubService.setActionsVariableStrict,
      ).toHaveBeenCalledTimes(1);
      expect(warning).toContain('will not verify on their hosts yet');
      expect(warning).toContain(KEY_VERSION);
    });

    it('warns and writes nothing when the signer identity is incomplete', async () => {
      const support = fakeSupport({
        ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
        ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT: SIGNER_ACCOUNT,
        ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER: undefined,
        ONPREM_LAB_SIGNING_KEY_PATH: '/run/keys/lab.pem',
      });

      const warning = await configure(support, onprem);

      expect(warning).toContain(
        'ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER must be set',
      );
      expectNoWrites(support);
    });

    it.each(['latest', 'v3', '1 2'])(
      'rejects a key version ending in %s and does not fall back to the lab key',
      async (version) => {
        const keyPath = join(tmpdir(), 'unused-lab.pem');
        const support = fakeSupport({
          ...kmsEnv(),
          ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION.replace(/3$/, version),
          ONPREM_LAB_SIGNING_KEY_PATH: keyPath,
        });

        const warning = await configure(support, onprem);

        expect(warning).toContain('must be a full Cloud KMS key version name');
        expectNoWrites(support);
      },
    );

    it('warns, without throwing, when GitHub refuses the variable', async () => {
      const support = fakeSupport(
        kmsEnv({ [KEY_VERSION]: keyPair().publicKey }),
      );
      support.githubService.setActionsVariableStrict.mockRejectedValueOnce(
        new Error('Resource not accessible by integration'),
      );

      const warning = await configure(support, onprem);

      expect(warning).toContain('acme/orders');
      expect(warning).toContain('Resource not accessible by integration');
      expect(warning).toContain(
        `the repository variable ${RELEASE_SIGNING_VARIABLE}`,
      );
    });
  });

  describe('lab key (lab only)', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'release-signing-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('sets the lab key as a repository secret and reports nothing when its key ID is trusted', async () => {
      const pair = keyPair();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pair.privateKey);
      const support = fakeSupport({
        ONPREM_LAB_SIGNING_KEY_PATH: keyPath,
        ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({
          [labSigningKeyId(pair.privateKey)]: pair.publicKey,
        }),
      });

      await expect(configure(support, onprem)).resolves.toBeUndefined();

      expect(support.githubService.setActionsSecretStrict).toHaveBeenCalledWith(
        'provisioning-token',
        'acme',
        'orders',
        RELEASE_SIGNING_SECRET,
        pair.privateKey,
      );
      expect(
        support.githubService.setActionsVariableStrict,
      ).not.toHaveBeenCalled();
    });

    it('still sets the secret but warns when the lab key ID is not trusted', async () => {
      const pair = keyPair();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pair.privateKey);
      const support = fakeSupport({ ONPREM_LAB_SIGNING_KEY_PATH: keyPath });

      const warning = await configure(support, onprem);

      expect(
        support.githubService.setActionsSecretStrict,
      ).toHaveBeenCalledTimes(1);
      expect(warning).toContain('will not verify on their hosts yet');
      expect(warning).toContain(labSigningKeyId(pair.privateKey));
    });

    it('warns when the trusted PEM for the lab key ID is a different key', async () => {
      const pair = keyPair();
      const other = keyPair();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pair.privateKey);
      const support = fakeSupport({
        ONPREM_LAB_SIGNING_KEY_PATH: keyPath,
        ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({
          [labSigningKeyId(pair.privateKey)]: other.publicKey,
        }),
      });

      const warning = await configure(support, onprem);

      expect(warning).toContain('is not the public key of');
    });

    it('warns with the setting name when the lab key file is missing', async () => {
      const support = fakeSupport({
        ONPREM_LAB_SIGNING_KEY_PATH: join(tempDir, 'absent.key'),
      });

      const warning = await configure(support, onprem);

      expect(warning).toContain(
        'ONPREM_LAB_SIGNING_KEY_PATH points to a file that cannot be read',
      );
      expect(
        support.githubService.setActionsSecretStrict,
      ).not.toHaveBeenCalled();
    });

    it('never puts the lab key into a warning or a log line', async () => {
      const pair = keyPair();
      const keyPath = join(tempDir, 'release-signing.key');
      writeFileSync(keyPath, pair.privateKey);
      const support = fakeSupport({ ONPREM_LAB_SIGNING_KEY_PATH: keyPath });
      support.githubService.setActionsSecretStrict.mockRejectedValueOnce(
        new Error('GitHub 502'),
      );
      const keyBody = pair.privateKey.split('\n')[1] ?? pair.privateKey;

      const warning = await configure(support, onprem);

      expect(warning).toContain('GitHub 502');
      expect(warning).not.toContain(keyBody);
      const logged = warn.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('GitHub 502');
      expect(logged).not.toContain(keyBody);
    });
  });

  describe('no signing configured', () => {
    it('warns, naming the settings to configure, and writes nothing', async () => {
      const support = fakeSupport();

      const warning = await configure(support, onprem);

      expect(warning).toContain('Releases cannot be signed yet');
      expect(warning).toContain('ALPHACI_RELEASE_KMS_KEY_VERSION');
      expect(warning).toContain('regenerate this project');
      expectNoWrites(support);
    });
  });
});

describe('withReleaseSigningWarning', () => {
  it('adds releaseSigningWarning only when there is a warning', () => {
    expect(withReleaseSigningWarning({ id: 'p1' }, undefined)).toEqual({
      id: 'p1',
    });
    expect(withReleaseSigningWarning({ id: 'p1' }, 'Set it.')).toEqual({
      id: 'p1',
      releaseSigningWarning: 'Set it.',
    });
  });
});
