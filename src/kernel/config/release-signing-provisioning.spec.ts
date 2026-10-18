import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { labSigningKeyId } from './release-signing-key';
import {
  RELEASE_SIGNING_SECRET,
  configureRepositoryReleaseSigning,
  type ReleaseSigningWriter,
} from './release-signing-provisioning';

describe('release signing provisioning with the backend as signer', () => {
  let dir: string;
  let labKeyPath: string;
  let labPublicPem: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-signing-provisioning-'));
    const pair = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    labKeyPath = join(dir, 'lab.key');
    writeFileSync(labKeyPath, pair.privateKey);
    labPublicPem = pair.publicKey;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writer = () => ({
    setActionsSecretStrict: jest.fn(async () => undefined),
    setActionsVariableStrict: jest.fn(async () => undefined),
  });
  const run = (github: ReleaseSigningWriter, env: Record<string, string>) =>
    configureRepositoryReleaseSigning({
      github,
      read: (key) => env[key],
      deliveredByHost: (provider) => provider === 'onprem-compose',
      accessToken: 'token',
      owner: 'Alpha-Explora',
      repo: 'orders-api',
      targets: [{ provider: 'onprem-compose' }],
      untrusted: 'write-and-warn',
    });

  it('writes no signing secret or variable to GitHub when the backend signs', async () => {
    const github = writer();
    const message = await run(github, {
      ALPHACI_RELEASE_SIGNER: 'file',
      ALPHACI_RELEASE_SIGNING_KEY_FILE: labKeyPath,
      // A lab key path set alongside must not be pushed either.
      ONPREM_LAB_SIGNING_KEY_PATH: labKeyPath,
    });
    expect(message).toBeUndefined();
    expect(github.setActionsSecretStrict).not.toHaveBeenCalled();
    expect(github.setActionsVariableStrict).not.toHaveBeenCalled();
  });

  it('keeps the runner lab-key behavior: the key is written and its trust reported', async () => {
    const github = writer();
    const message = await run(github, {
      ONPREM_LAB_SIGNING_KEY_PATH: labKeyPath,
      ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({
        [labSigningKeyId(labPublicPem)]: labPublicPem,
      }),
    });
    expect(message).toBeUndefined();
    expect(github.setActionsSecretStrict).toHaveBeenCalledWith(
      'token',
      'Alpha-Explora',
      'orders-api',
      RELEASE_SIGNING_SECRET,
      expect.stringContaining('BEGIN PRIVATE KEY'),
    );
  });
});
