import { createPublicKey } from 'node:crypto';

import type { MigrationFile } from '../scripts/selfhost-migrations';

import {
  derivedUrlProblems,
  DoctorProbes,
  formatResults,
  migrationsCheck,
  onpremChecks,
  onpremSettingsProblems,
  onpremTrustKeyCheck,
  runDoctor,
  settingProblems,
  signingKeyCheck,
  trustKeyIds,
} from './doctor';
import { generateP256PrivateKeyPem, releaseKeyId } from './release-key';

const SESSION = 'a'.repeat(64);

function goodEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    ALPHACI_EDITION: 'enterprise',
    ALPHACI_BUILD_PROFILE: 'enterprise',
    ALPHACI_DEPLOYMENT_MODE: 'selfhosted',
    SUBSCRIPTION_GATE_ENABLED: 'false',
    TRUST_PROXY_HOPS: '1',
    SESSION_SECURE: 'true',
    STORAGE_DRIVER: 'postgres',
    ALPHACI_RELEASE_SIGNER: 'file',
    ALPHACI_HOSTNAME: 'alphaci.example.com',
    PLATFORM_PUBLIC_URL: 'https://alphaci.example.com',
    FRONTEND_URL: 'https://alphaci.example.com',
    ALLOWED_ORIGINS: 'https://alphaci.example.com',
    GITHUB_CALLBACK_URL:
      'https://alphaci.example.com/api/v1/auth/github/callback',
    ALPHACI_RELEASE_SIGNING_KEY_FILE: '/run/secrets/release_signing_key',
    GITHUB_CLIENT_ID: 'Iv1.example',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_SLUG: 'alphaci-example',
    GITHUB_ENFORCED_ORG: 'acme',
    DATABASE_URL: 'postgres://alphaci:pw@db:5432/alphaci?sslmode=disable',
    SESSION_SECRET: SESSION,
    ENV_PROVISIONING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GITHUB_CLIENT_SECRET: 'oauth-secret',
    GITHUB_APP_PRIVATE_KEY: 'pem-placeholder',
    GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret',
  };
}

function migration(version: string, checksum: string): MigrationFile {
  return {
    version,
    relativePath: `identity-access/${version}.sql`,
    sql: 'SELECT 1;',
    checksum,
    transactionMode: 'wrapped',
  };
}

function fakeProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const key = generateP256PrivateKeyPem();
  const files = [
    migration('20260101000000_a', 'sum-a'),
    migration('20260102000000_b', 'sum-b'),
  ];
  return {
    checkDatabase: async () => undefined,
    readLedger: async () =>
      new Map([
        ['20260101000000_a', 'sum-a'],
        ['20260102000000_b', 'sum-b'],
      ]),
    listMigrations: () => files,
    readFile: () => key,
    probeHttps: async () => 200,
    ...overrides,
  };
}

function byName(
  results: Awaited<ReturnType<typeof runDoctor>>,
  prefix: string,
) {
  const found = results.find((result) => result.name.startsWith(prefix));
  if (!found) throw new Error(`no check named ${prefix}`);
  return found;
}

describe('runDoctor', () => {
  it('passes every check on a correctly set up appliance', async () => {
    const results = await runDoctor(goodEnv(), fakeProbes());

    expect(results.every((result) => result.ok)).toBe(true);
    expect(formatResults(results)).toMatch(/doctor: all checks passed$/);
  });

  it('prints the release signing key ID, never the key', async () => {
    const pem = generateP256PrivateKeyPem();
    const results = await runDoctor(
      goodEnv(),
      fakeProbes({ readFile: () => pem }),
    );

    const signer = byName(results, 'release signing key');
    expect(signer.ok).toBe(true);
    expect(signer.detail).toBe(`key ID ${releaseKeyId(pem)}`);
    expect(formatResults(results)).not.toContain('PRIVATE KEY');
  });

  it('keeps going when the database is unreachable, and says why migrations were not checked', async () => {
    const results = await runDoctor(
      goodEnv(),
      fakeProbes({
        checkDatabase: async () => {
          throw new Error('connect ECONNREFUSED db:5432');
        },
      }),
    );

    expect(byName(results, 'database is reachable')).toMatchObject({
      ok: false,
      detail: 'connect ECONNREFUSED db:5432',
    });
    expect(byName(results, 'migrations are at head').detail).toBe(
      'not checked: the database is unreachable',
    );
    expect(byName(results, 'outbound HTTPS to api.github.com').ok).toBe(true);
  });

  it('fails when the ledger has not caught up with the files', async () => {
    const results = await runDoctor(
      goodEnv(),
      fakeProbes({
        readLedger: async () => new Map([['20260101000000_a', 'sum-a']]),
      }),
    );

    expect(byName(results, 'migrations are at head')).toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        '1 pending (next: identity-access/20260102000000_b.sql)',
      ),
    });
  });

  it('fails when an applied migration file has been edited', async () => {
    const results = await runDoctor(
      goodEnv(),
      fakeProbes({
        readLedger: async () =>
          new Map([
            ['20260101000000_a', 'sum-a'],
            ['20260102000000_b', 'different'],
          ]),
      }),
    );

    expect(byName(results, 'migrations are at head').ok).toBe(false);
    expect(byName(results, 'migrations are at head').detail).toContain(
      'was already applied',
    );
  });

  it('names the outbound host that did not answer and no other', async () => {
    const results = await runDoctor(
      goodEnv(),
      fakeProbes({
        probeHttps: async (url) => {
          if (url.includes('ghcr.io'))
            throw new Error('getaddrinfo ENOTFOUND ghcr.io');
          return 200;
        },
      }),
    );

    expect(byName(results, 'outbound HTTPS to ghcr.io')).toMatchObject({
      ok: false,
      detail: 'no response: getaddrinfo ENOTFOUND ghcr.io',
    });
    expect(byName(results, 'outbound HTTPS to api.github.com').ok).toBe(true);
  });

  it('flags a PLATFORM_PUBLIC_URL that GitHub runners cannot reach', async () => {
    const env = { ...goodEnv(), PLATFORM_PUBLIC_URL: 'https://localhost:4000' };
    const results = await runDoctor(env, fakeProbes());

    expect(byName(results, 'PLATFORM_PUBLIC_URL').ok).toBe(false);
  });
});

describe('settingProblems', () => {
  it('reports a missing setting by name', () => {
    const env = goodEnv();
    delete env['GITHUB_CLIENT_ID'];

    expect(settingProblems(env)).toContain('GITHUB_CLIENT_ID is not set');
  });

  it('reports a wrong pinned value with what was found', () => {
    const env = { ...goodEnv(), SUBSCRIPTION_GATE_ENABLED: 'true' };

    expect(settingProblems(env)).toContain(
      'SUBSCRIPTION_GATE_ENABLED must be "false" (is "true")',
    );
  });

  it('never echoes a secret value in a problem', () => {
    const env = { ...goodEnv(), SESSION_SECRET: 'short-secret-value' };
    const problems = settingProblems(env);

    expect(problems).toEqual(['SESSION_SECRET must be at least 32 characters']);
    expect(problems.join(' ')).not.toContain('short-secret-value');
  });

  it('requires the file signer', () => {
    const env = { ...goodEnv(), ALPHACI_RELEASE_SIGNER: 'runner' };

    expect(settingProblems(env)).toContain(
      'ALPHACI_RELEASE_SIGNER must be "file" (is "runner")',
    );
  });
});

describe('derivedUrlProblems', () => {
  it('is empty when every URL matches the hostname', () => {
    expect(derivedUrlProblems(goodEnv())).toEqual([]);
  });

  it('names each URL that drifted from ALPHACI_HOSTNAME', () => {
    const env = { ...goodEnv(), FRONTEND_URL: 'https://old.example.com' };

    expect(derivedUrlProblems(env)).toEqual([
      'FRONTEND_URL should be https://alphaci.example.com, derived from ALPHACI_HOSTNAME',
    ]);
  });
});

describe('signingKeyCheck', () => {
  it('fails when the path is not set', () => {
    const env = { ...goodEnv(), ALPHACI_RELEASE_SIGNING_KEY_FILE: '' };

    expect(signingKeyCheck(env, () => '')).toMatchObject({
      ok: false,
      detail: 'ALPHACI_RELEASE_SIGNING_KEY_FILE is not set',
    });
  });

  it('fails with the path when the file cannot be read', () => {
    const result = signingKeyCheck(goodEnv(), () => {
      throw new Error('ENOENT');
    });

    expect(result).toMatchObject({
      ok: false,
      detail: 'cannot read /run/secrets/release_signing_key',
    });
  });
});

describe('migrationsCheck', () => {
  it('passes with nothing pending and reports the applied count', () => {
    const files = [migration('20260101000000_a', 'sum-a')];

    expect(
      migrationsCheck(files, new Map([['20260101000000_a', 'sum-a']])),
    ).toEqual({
      name: 'migrations are at head',
      ok: true,
      detail: '1 applied',
    });
  });

  it('notes a recorded version that no file in this image provides, without failing', () => {
    const files = [migration('20260101000000_a', 'sum-a')];
    const result = migrationsCheck(
      files,
      new Map([
        ['20260101000000_a', 'sum-a'],
        ['20270101000000_newer', 'sum-x'],
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.detail).toContain(
      '1 recorded version(s) have no file in this image',
    );
  });
});

describe('formatResults', () => {
  it('counts failures in the summary line', () => {
    const text = formatResults([
      { name: 'a', ok: true, detail: 'fine' },
      { name: 'b', ok: false, detail: 'broken' },
      { name: 'c', ok: false, detail: 'also broken' },
    ]);

    expect(text.split('\n')).toEqual([
      '[PASS] a: fine',
      '[FAIL] b: broken',
      '[FAIL] c: also broken',
      'doctor: 2 check(s) failed',
    ]);
  });
});

const INSTALLER_URL =
  'https://github.com/acme/alphaci-agent/releases/download/onprem-agent-v0.2.0/alphaci-agent-0.2.0.tar.gz';

/** A correctly set up on-prem install: on-prem on, file signer, explicit installer. */
function onpremEnv(): NodeJS.ProcessEnv {
  return {
    ...goodEnv(),
    ONPREM_RELEASES_ENABLED: 'true',
    ENV_PROVISIONING_ENABLED: 'true',
    ONPREM_INSTALLER_URL: INSTALLER_URL,
    ONPREM_INSTALLER_SHA256: 'a'.repeat(64),
  };
}

function publicPemOf(privatePem: string): string {
  return createPublicKey(privatePem)
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

describe('onpremChecks', () => {
  it('returns nothing when on-prem is off, unset or not exactly "true"', () => {
    const readFile = () => generateP256PrivateKeyPem();
    for (const value of [undefined, 'false', 'TRUE', '1', ' true']) {
      const env = { ...onpremEnv(), ONPREM_RELEASES_ENABLED: value };
      expect(onpremChecks(env, readFile)).toEqual([]);
    }
  });

  it('passes with the file signer and an explicit installer, and prints the key ID', () => {
    const key = generateP256PrivateKeyPem();
    const results = onpremChecks(onpremEnv(), () => key);

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(results[1]?.detail).toContain(`key ID ${releaseKeyId(key)}`);
    expect(results[1]?.detail).toContain('ALPHACI_RELEASE_SIGNER=file');
    expect(results.map((result) => result.detail).join('\n')).not.toContain(
      '-----BEGIN',
    );
  });

  it('accepts a release repository in place of an explicit installer URL', () => {
    const env = onpremEnv();
    delete env['ONPREM_INSTALLER_URL'];
    delete env['ONPREM_INSTALLER_SHA256'];
    env['ONPREM_INSTALLER_RELEASE_REPO'] = 'acme/alphaci-agent';

    expect(onpremSettingsProblems(env)).toEqual([]);
  });

  it('fails when ENV_PROVISIONING_ENABLED is not "true"', () => {
    const env = onpremEnv();
    env['ENV_PROVISIONING_ENABLED'] = 'false';

    expect(onpremSettingsProblems(env)).toEqual([
      'ENV_PROVISIONING_ENABLED must be "true": releases, and so host deployments, need it',
    ]);
  });

  it('names both installer sources when neither is configured', () => {
    const env = onpremEnv();
    delete env['ONPREM_INSTALLER_URL'];
    delete env['ONPREM_INSTALLER_SHA256'];

    expect(onpremSettingsProblems(env)).toEqual([
      'set ONPREM_INSTALLER_RELEASE_REPO to owner/repo, or ONPREM_INSTALLER_URL with ONPREM_INSTALLER_SHA256',
    ]);
  });

  it('refuses a URL without an https scheme or a valid hash', () => {
    const env = onpremEnv();
    env['ONPREM_INSTALLER_URL'] = 'http://example.com/agent.tar.gz';
    expect(onpremSettingsProblems(env)).toHaveLength(1);

    env['ONPREM_INSTALLER_URL'] = INSTALLER_URL;
    env['ONPREM_INSTALLER_SHA256'] = 'ABC';
    expect(onpremSettingsProblems(env)[0]).toContain(
      'ONPREM_INSTALLER_URL needs',
    );
  });

  it('checks the repository and version formats the backend uses', () => {
    const env = onpremEnv();
    delete env['ONPREM_INSTALLER_URL'];
    delete env['ONPREM_INSTALLER_SHA256'];
    env['ONPREM_INSTALLER_RELEASE_REPO'] = 'no-slash';
    expect(onpremSettingsProblems(env)).toEqual([
      'ONPREM_INSTALLER_RELEASE_REPO must be owner/repo',
    ]);

    env['ONPREM_INSTALLER_RELEASE_REPO'] = 'acme/alphaci-agent';
    env['ONPREM_INSTALLER_VERSION'] = '0.2';
    expect(onpremSettingsProblems(env)).toEqual([
      'ONPREM_INSTALLER_VERSION must be x.y.z',
    ]);
  });

  it('fails the trust check when the signing key file cannot be read, naming the path only', () => {
    const results = onpremChecks(onpremEnv(), () => {
      throw new Error('ENOENT');
    });

    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.detail).toBe(
      'cannot read /run/secrets/release_signing_key',
    );
  });

  it('uses the listed trust keys without the file signer', () => {
    const key = generateP256PrivateKeyPem();
    const env = onpremEnv();
    env['ALPHACI_RELEASE_SIGNER'] = 'runner';
    env['ALPHACI_RELEASE_TRUST_KEYS_JSON'] = JSON.stringify({
      'sha256:old': publicPemOf(key),
    });

    const trust = onpremTrustKeyCheck(env, () => key);
    expect(trust.ok).toBe(true);
    expect(trust.detail).toBe('trusted key IDs: sha256:old');
  });

  it('fails without the file signer and without any trust key', () => {
    const env = onpremEnv();
    env['ALPHACI_RELEASE_SIGNER'] = 'runner';
    delete env['ALPHACI_RELEASE_TRUST_KEYS_JSON'];

    expect(onpremTrustKeyCheck(env, () => '').ok).toBe(false);
  });

  it('rejects a trust setting that enrollment would refuse, without echoing the key', () => {
    const key = generateP256PrivateKeyPem();
    const env = onpremEnv();
    env['ALPHACI_RELEASE_TRUST_KEYS_JSON'] = JSON.stringify({
      'sha256:bad': key,
    });

    const trust = onpremTrustKeyCheck(env, () => key);
    expect(trust.ok).toBe(false);
    expect(trust.detail).toBe('trust entry sha256:bad is not a PEM public key');
    expect(trust.detail).not.toContain('PRIVATE');
  });
});

describe('trustKeyIds', () => {
  it('rejects a value that is not JSON, not an object, or not a readable PEM', () => {
    const rsa = `-----BEGIN PUBLIC KEY-----\n${'A'.repeat(64)}\n-----END PUBLIC KEY-----`;

    expect(trustKeyIds('not json')).toEqual({
      problem: 'ALPHACI_RELEASE_TRUST_KEYS_JSON is not JSON',
    });
    expect(trustKeyIds('[]')).toMatchObject({ problem: expect.any(String) });
    expect(trustKeyIds(JSON.stringify({ 'sha256:x': rsa }))).toEqual({
      problem: 'trust entry sha256:x is not a readable PEM public key',
    });
  });

  it('returns the IDs of a valid P-256 trust set', () => {
    const pem = publicPemOf(generateP256PrivateKeyPem());
    expect(trustKeyIds(JSON.stringify({ 'sha256:one': pem }))).toEqual({
      ids: ['sha256:one'],
    });
  });
});

describe('runDoctor with on-prem hosts', () => {
  it('adds no on-prem lines when on-prem is off', async () => {
    const results = await runDoctor(goodEnv(), fakeProbes());

    expect(results.some((result) => /on-prem/i.test(result.name))).toBe(false);
    expect(formatResults(results)).not.toMatch(/on-prem/i);
  });

  it('adds the two on-prem checks and passes them when configured', async () => {
    const results = await runDoctor(onpremEnv(), fakeProbes());

    expect(
      results.filter((result) => /on-prem/i.test(result.name)),
    ).toHaveLength(2);
    expect(byName(results, 'on-prem settings').ok).toBe(true);
    expect(byName(results, 'release trust key for on-prem').ok).toBe(true);
  });
});
