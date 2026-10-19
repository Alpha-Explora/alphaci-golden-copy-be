import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { generateP256PrivateKeyPem, p256KeyProblem } from './release-key';
import {
  containerSecretPath,
  databaseUrlFor,
  deriveUrls,
  hostnameProblem,
  InitError,
  renderAlphaciEnv,
  runInit,
  tlsDirective,
} from './selfhost-init';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXAMPLE_PATH = join(
  REPO_ROOT,
  'deploy',
  'selfhost',
  'alphaci.env.example',
);

/**
 * KEY=value lines of an env file, ignoring comments and blank lines. Tolerates
 * CRLF, because a Windows checkout with autocrlf writes CRLF line endings.
 */
function envKeys(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    entries.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return entries;
}

describe('hostnameProblem', () => {
  it.each([
    'alphaci.example.com',
    'a.b-c.example',
    'localhost',
    'ALPHACI.Example.COM',
  ])('accepts %s', (hostname) => {
    expect(hostnameProblem(hostname)).toBeUndefined();
  });

  it.each([
    'https://alphaci.example.com',
    'alphaci.example.com:8443',
    'alphaci.example.com/api',
    'alpha ci.example.com',
    '-bad.example.com',
    'bad..example.com',
    '',
  ])('rejects %j', (hostname) => {
    expect(hostnameProblem(hostname)).toEqual(expect.any(String));
  });
});

describe('tlsDirective', () => {
  it('maps each mode to the Caddy tls argument', () => {
    expect(tlsDirective('auto')).toBe('');
    expect(tlsDirective('internal')).toBe('internal');
    expect(tlsDirective('custom')).toBe(
      '/certs/fullchain.pem /certs/privkey.pem',
    );
  });
});

describe('deriveUrls', () => {
  it('derives every public URL from the one hostname', () => {
    expect(deriveUrls('alphaci.example.com')).toEqual({
      platformPublicUrl: 'https://alphaci.example.com',
      frontendUrl: 'https://alphaci.example.com',
      allowedOrigins: 'https://alphaci.example.com',
      githubCallbackUrl:
        'https://alphaci.example.com/api/v1/auth/github/callback',
    });
  });
});

describe('renderAlphaciEnv', () => {
  const rendered = envKeys(renderAlphaciEnv('alphaci.example.com', 'internal'));

  it('writes the derived URLs, the TLS directive and the pinned profile', () => {
    expect(rendered.get('ALPHACI_HOSTNAME')).toBe('alphaci.example.com');
    expect(rendered.get('ALPHACI_TLS_DIRECTIVE')).toBe('internal');
    expect(rendered.get('PLATFORM_PUBLIC_URL')).toBe(
      'https://alphaci.example.com',
    );
    expect(rendered.get('FRONTEND_URL')).toBe('https://alphaci.example.com');
    expect(rendered.get('ALLOWED_ORIGINS')).toBe('https://alphaci.example.com');
    expect(rendered.get('GITHUB_CALLBACK_URL')).toBe(
      'https://alphaci.example.com/api/v1/auth/github/callback',
    );
    expect(rendered.get('SUBSCRIPTION_GATE_ENABLED')).toBe('false');
    expect(rendered.get('TRUST_PROXY_HOPS')).toBe('1');
    expect(rendered.get('ALPHACI_EDITION')).toBe('enterprise');
    expect(rendered.get('ALPHACI_RELEASE_SIGNER')).toBe('file');
  });

  it('points every secret at its container path, never at a value', () => {
    expect(rendered.get('DATABASE_URL_FILE')).toBe(
      containerSecretPath('database_url'),
    );
    expect(rendered.get('SESSION_SECRET_FILE')).toBe(
      containerSecretPath('session_secret'),
    );
    expect(rendered.get('GITHUB_CLIENT_SECRET_FILE')).toBe(
      containerSecretPath('github_oauth_client_secret'),
    );
    expect(rendered.get('GITHUB_APP_PRIVATE_KEY_FILE')).toBe(
      containerSecretPath('github_app_private_key'),
    );
    expect(rendered.get('ALPHACI_RELEASE_SIGNING_KEY_FILE')).toBe(
      containerSecretPath('release_signing_key'),
    );
    expect(rendered.has('SESSION_SECRET')).toBe(false);
    expect(rendered.has('DATABASE_URL')).toBe(false);
  });

  it('matches the committed alphaci.env.example key for key', () => {
    const example = envKeys(readFileSync(EXAMPLE_PATH, 'utf8'));

    expect([...example.keys()].sort()).toEqual([...rendered.keys()].sort());
  });

  it('keeps the example public URLs derived from ALPHACI_HOSTNAME', () => {
    const example = envKeys(readFileSync(EXAMPLE_PATH, 'utf8'));
    const origin = `https://${example.get('ALPHACI_HOSTNAME') ?? ''}`;

    expect(example.get('PLATFORM_PUBLIC_URL')).toBe(origin);
    expect(example.get('FRONTEND_URL')).toBe(origin);
    expect(example.get('ALLOWED_ORIGINS')).toBe(origin);
    expect(example.get('GITHUB_CALLBACK_URL')).toBe(
      `${origin}/api/v1/auth/github/callback`,
    );
  });
});

describe('databaseUrlFor', () => {
  it('targets the in-compose database with TLS disabled', () => {
    expect(databaseUrlFor('abc')).toBe(
      'postgres://alphaci:abc@db:5432/alphaci?sslmode=disable',
    );
  });
});

describe('runInit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alphaci-init-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates alphaci.env and the generated secrets on a fresh directory', () => {
    const report = runInit({
      dir,
      hostname: 'Alphaci.Example.com',
      tls: 'auto',
      newReleaseKeyPem: generateP256PrivateKeyPem,
    });

    expect(report.created).toEqual([
      'alphaci.env',
      'secrets/session_secret',
      'secrets/db_password',
      'secrets/database_url',
      'secrets/release_signing_key',
      'secrets/env_provisioning_encryption_key',
      'secrets/onprem_registry_token',
      'secrets/sonar_token',
    ]);
    expect(report.kept).toEqual([]);
    expect(report.missingCustomerSecrets).toEqual([
      'github_app_private_key',
      'github_oauth_client_secret',
      'github_app_webhook_secret',
    ]);
    expect(readFileSync(join(dir, 'alphaci.env'), 'utf8')).toContain(
      'ALPHACI_HOSTNAME=alphaci.example.com',
    );
  });

  it('generates a 64-character session secret, a P-256 release key and a 32-byte base64 provisioning key', () => {
    runInit({ dir, hostname: 'alphaci.example.com', tls: 'auto' });
    const provisioning = readFileSync(
      join(dir, 'secrets', 'env_provisioning_encryption_key'),
      'utf8',
    ).trim();
    expect(Buffer.from(provisioning, 'base64')).toHaveLength(32);
  });

  it('generates a 64-character session secret and a P-256 release key', () => {
    runInit({ dir, hostname: 'alphaci.example.com', tls: 'auto' });

    const session = readFileSync(
      join(dir, 'secrets', 'session_secret'),
      'utf8',
    ).trim();
    expect(session).toMatch(/^[0-9a-f]{64}$/);

    const key = readFileSync(
      join(dir, 'secrets', 'release_signing_key'),
      'utf8',
    );
    expect(p256KeyProblem(key, 'KEY')).toBeUndefined();
  });

  it('builds the database URL from the same password it wrote', () => {
    runInit({ dir, hostname: 'alphaci.example.com', tls: 'auto' });

    const password = readFileSync(
      join(dir, 'secrets', 'db_password'),
      'utf8',
    ).trim();
    const url = readFileSync(
      join(dir, 'secrets', 'database_url'),
      'utf8',
    ).trim();
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(url).toBe(databaseUrlFor(password));
  });

  it('never overwrites an existing file, and reports it as kept', () => {
    runInit({ dir, hostname: 'alphaci.example.com', tls: 'auto' });
    const before = {
      env: readFileSync(join(dir, 'alphaci.env'), 'utf8'),
      session: readFileSync(join(dir, 'secrets', 'session_secret'), 'utf8'),
      key: readFileSync(join(dir, 'secrets', 'release_signing_key'), 'utf8'),
    };

    const second = runInit({
      dir,
      hostname: 'other.example.com',
      tls: 'internal',
    });

    expect(second.created).toEqual([]);
    expect(second.kept).toEqual([
      'alphaci.env',
      'secrets/session_secret',
      'secrets/db_password',
      'secrets/database_url',
      'secrets/release_signing_key',
      'secrets/env_provisioning_encryption_key',
      'secrets/onprem_registry_token',
      'secrets/sonar_token',
    ]);
    expect(readFileSync(join(dir, 'alphaci.env'), 'utf8')).toBe(before.env);
    expect(readFileSync(join(dir, 'secrets', 'session_secret'), 'utf8')).toBe(
      before.session,
    );
    expect(
      readFileSync(join(dir, 'secrets', 'release_signing_key'), 'utf8'),
    ).toBe(before.key);
  });

  it('reuses an existing db_password when rebuilding a missing database_url', () => {
    runInit({ dir, hostname: 'alphaci.example.com', tls: 'auto' });
    const password = readFileSync(
      join(dir, 'secrets', 'db_password'),
      'utf8',
    ).trim();
    rmSync(join(dir, 'secrets', 'database_url'));

    const report = runInit({
      dir,
      hostname: 'alphaci.example.com',
      tls: 'auto',
    });

    expect(report.created).toEqual(['secrets/database_url']);
    expect(
      readFileSync(join(dir, 'secrets', 'database_url'), 'utf8').trim(),
    ).toBe(databaseUrlFor(password));
  });

  it('writes secret files readable only by their owner', () => {
    if (process.platform === 'win32') return;
    runInit({ dir, hostname: 'alphaci.example.com', tls: 'auto' });

    for (const name of [
      'session_secret',
      'db_password',
      'database_url',
      'release_signing_key',
    ]) {
      expect(statSync(join(dir, 'secrets', name)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses an invalid hostname before writing anything', () => {
    expect(() =>
      runInit({ dir, hostname: 'https://alphaci.example.com', tls: 'auto' }),
    ).toThrow(InitError);
    expect(() => readFileSync(join(dir, 'alphaci.env'))).toThrow();
  });

  it('keeps a hand-edited alphaci.env intact and still generates the missing secrets', () => {
    writeFileSync(
      join(dir, 'alphaci.env'),
      'ALPHACI_HOSTNAME=hand.example.com\n',
    );

    const report = runInit({
      dir,
      hostname: 'alphaci.example.com',
      tls: 'auto',
    });

    expect(report.kept).toEqual(['alphaci.env']);
    expect(report.created).toContain('secrets/session_secret');
    expect(readFileSync(join(dir, 'alphaci.env'), 'utf8')).toBe(
      'ALPHACI_HOSTNAME=hand.example.com\n',
    );
  });
});
