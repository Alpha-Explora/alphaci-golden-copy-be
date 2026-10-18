import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';

import type { TlsMode } from './args';
import { generateP256PrivateKeyPem } from './release-key';

/** Postgres role and database the compose file creates. One role owns everything. */
export const DB_USER = 'alphaci';
export const DB_NAME = 'alphaci';
export const DB_HOST = 'db';

/**
 * Secret files under secrets/ on the host. Compose mounts each one at
 * /run/secrets/<name>, and alphaci.env points the *_FILE variables there.
 */
export const SECRET_FILES = {
  sessionSecret: 'session_secret',
  dbPassword: 'db_password',
  databaseUrl: 'database_url',
  releaseSigningKey: 'release_signing_key',
  envProvisioningKey: 'env_provisioning_encryption_key',
  githubAppPrivateKey: 'github_app_private_key',
  githubOauthClientSecret: 'github_oauth_client_secret',
  githubAppWebhookSecret: 'github_app_webhook_secret',
} as const;

/** The secrets init generates. The GitHub ones come from the customer's own apps. */
export const GENERATED_SECRETS = [
  SECRET_FILES.sessionSecret,
  SECRET_FILES.dbPassword,
  SECRET_FILES.databaseUrl,
  SECRET_FILES.releaseSigningKey,
  SECRET_FILES.envProvisioningKey,
] as const;

/** Secrets the operator must place by hand before `compose up`. */
export const CUSTOMER_SECRETS = [
  SECRET_FILES.githubAppPrivateKey,
  SECRET_FILES.githubOauthClientSecret,
  SECRET_FILES.githubAppWebhookSecret,
] as const;

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Why a hostname cannot be used, or undefined. Accepts a bare DNS name only. */
export function hostnameProblem(raw: string): string | undefined {
  const hostname = raw.trim().toLowerCase();
  if (hostname === '') return 'The hostname is empty.';
  if (/[:/?#@\s]/.test(hostname)) {
    return `"${raw}" is not a bare hostname. Give the name only, without https:// or a port or path.`;
  }
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return `"${raw}" is not a valid DNS name.`;
  }
  return undefined;
}

/** The Caddy `tls` argument for each mode. Empty means Caddy's automatic HTTPS. */
export function tlsDirective(mode: TlsMode): string {
  switch (mode) {
    case 'auto':
      return '';
    case 'internal':
      return 'internal';
    case 'custom':
      return '/certs/fullchain.pem /certs/privkey.pem';
  }
}

/**
 * The non-secret settings for one hostname. Every public URL comes from the
 * one hostname, so the three values that must agree cannot drift apart. doctor
 * checks them again against ALPHACI_HOSTNAME.
 */
export function deriveUrls(hostname: string): {
  platformPublicUrl: string;
  frontendUrl: string;
  allowedOrigins: string;
  githubCallbackUrl: string;
} {
  const origin = `https://${hostname}`;
  return {
    platformPublicUrl: origin,
    frontendUrl: origin,
    allowedOrigins: origin,
    githubCallbackUrl: `${origin}/api/v1/auth/github/callback`,
  };
}

/** The container path a secret file is mounted at. */
export function containerSecretPath(name: string): string {
  return `/run/secrets/${name}`;
}

/** Postgres URL for the in-compose database. TLS is off: the db has no TLS, and it is not published. */
export function databaseUrlFor(password: string): string {
  return `postgres://${DB_USER}:${password}@${DB_HOST}:5432/${DB_NAME}?sslmode=disable`;
}

/**
 * The contents of alphaci.env. Matches deploy/selfhost/alphaci.env.example key
 * for key; a unit test keeps the two in step.
 */
export function renderAlphaciEnv(hostname: string, tls: TlsMode): string {
  const urls = deriveUrls(hostname);
  const lines = [
    '# AlphaCI self-hosted settings, written by alphaci-ctl init.',
    '# Non-secret values only. Secrets live in secrets/ and are referenced by *_FILE.',
    '# Full commentary: deploy/selfhost/alphaci.env.example.',
    '',
    '# --- Public address (one hostname; every URL below derives from it) ---',
    `ALPHACI_HOSTNAME=${hostname}`,
    `ALPHACI_TLS_DIRECTIVE=${tlsDirective(tls)}`,
    `PLATFORM_PUBLIC_URL=${urls.platformPublicUrl}`,
    `FRONTEND_URL=${urls.frontendUrl}`,
    `ALLOWED_ORIGINS=${urls.allowedOrigins}`,
    `GITHUB_CALLBACK_URL=${urls.githubCallbackUrl}`,
    '',
    '# --- Runtime ---',
    'NODE_ENV=production',
    'PORT=4000',
    'ALPHACI_EDITION=enterprise',
    'ALPHACI_BUILD_PROFILE=enterprise',
    'ALPHACI_DEPLOYMENT_MODE=selfhosted',
    'SUBSCRIPTION_GATE_ENABLED=false',
    'ENABLE_SWAGGER=false',
    'TRUST_PROXY_HOPS=1',
    'SESSION_SECURE=true',
    'SESSION_COOKIE_SAMESITE=lax',
    'SESSION_STORE_DRIVER=postgres',
    'STORAGE_DRIVER=postgres',
    'OUTBOX_RELAY_INTERVAL_MS=15000',
    '',
    '# --- Release signing (the backend signs with a customer-held key) ---',
    'ALPHACI_RELEASE_SIGNER=file',
    `ALPHACI_RELEASE_SIGNING_KEY_FILE=${containerSecretPath(SECRET_FILES.releaseSigningKey)}`,
    '',
    '# --- GitHub App and OAuth App (fill in before compose up) ---',
    'GITHUB_CLIENT_ID=',
    'GITHUB_APP_ID=',
    'GITHUB_APP_SLUG=',
    'GITHUB_ENFORCED_ORG=',
    'MEMBER_DIRECTORY_SOURCE=github_org',
    'HIERARCHY_GITHUB_SYNC_MODE=stub',
    '',
    '# --- Secrets, read from files ---',
    `DATABASE_URL_FILE=${containerSecretPath(SECRET_FILES.databaseUrl)}`,
    `SESSION_SECRET_FILE=${containerSecretPath(SECRET_FILES.sessionSecret)}`,
    `ENV_PROVISIONING_ENCRYPTION_KEY_FILE=${containerSecretPath(SECRET_FILES.envProvisioningKey)}`,
    `GITHUB_CLIENT_SECRET_FILE=${containerSecretPath(SECRET_FILES.githubOauthClientSecret)}`,
    `GITHUB_APP_PRIVATE_KEY_FILE=${containerSecretPath(SECRET_FILES.githubAppPrivateKey)}`,
    `GITHUB_APP_WEBHOOK_SECRET_FILE=${containerSecretPath(SECRET_FILES.githubAppWebhookSecret)}`,
    '',
  ];
  return lines.join('\n');
}

export interface InitOptions {
  readonly dir: string;
  readonly hostname: string;
  readonly tls: TlsMode;
  /** Injectable for tests. Defaults to the platform CSPRNG and a P-256 keygen. */
  readonly randomHex?: (bytes: number) => string;
  readonly newReleaseKeyPem?: () => string;
}

export interface InitReport {
  /** Paths, relative to dir, that this run created. */
  readonly created: string[];
  /** Paths, relative to dir, that already existed and were left alone. */
  readonly kept: string[];
  /** Customer secrets that are still missing. */
  readonly missingCustomerSecrets: string[];
}

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}

/**
 * Writes alphaci.env and the generated secrets. A file that already exists is
 * never overwritten: each file is created with O_EXCL, so two runs cannot race
 * over the same secret either. The database URL reuses an existing db_password,
 * so a kept password and the URL stay in step.
 */
export function runInit(options: InitOptions): InitReport {
  const problem = hostnameProblem(options.hostname);
  if (problem !== undefined) throw new InitError(problem);
  const hostname = options.hostname.trim().toLowerCase();

  const randomHex =
    options.randomHex ??
    ((bytes: number) => randomBytes(bytes).toString('hex'));
  const newReleaseKeyPem =
    options.newReleaseKeyPem ?? generateP256PrivateKeyPem;

  const secretsDir = join(options.dir, 'secrets');
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const created: string[] = [];
  const kept: string[] = [];
  const record = (relative: string, wasCreated: boolean): void => {
    (wasCreated ? created : kept).push(relative);
  };

  record(
    'alphaci.env',
    writeNew(
      join(options.dir, 'alphaci.env'),
      renderAlphaciEnv(hostname, options.tls),
    ),
  );

  const sessionPath = join(secretsDir, SECRET_FILES.sessionSecret);
  record(
    `secrets/${SECRET_FILES.sessionSecret}`,
    writeNew(sessionPath, `${randomHex(32)}\n`),
  );

  const dbPasswordPath = join(secretsDir, SECRET_FILES.dbPassword);
  const dbPasswordCreated = writeNew(dbPasswordPath, `${randomHex(24)}\n`);
  record(`secrets/${SECRET_FILES.dbPassword}`, dbPasswordCreated);
  const dbPassword = readTrimmed(dbPasswordPath);

  record(
    `secrets/${SECRET_FILES.databaseUrl}`,
    writeNew(
      join(secretsDir, SECRET_FILES.databaseUrl),
      `${databaseUrlFor(dbPassword)}\n`,
    ),
  );

  record(
    `secrets/${SECRET_FILES.releaseSigningKey}`,
    writeNew(
      join(secretsDir, SECRET_FILES.releaseSigningKey),
      newReleaseKeyPem,
    ),
  );

  // The 32-byte key that encrypts environment tokens at rest. The backend reads it
  // at boot even when env provisioning is off, so it is always generated. Losing it
  // makes the stored tokens unreadable, so it belongs in the backup.
  record(
    `secrets/${SECRET_FILES.envProvisioningKey}`,
    writeNew(
      join(secretsDir, SECRET_FILES.envProvisioningKey),
      () => `${Buffer.from(randomHex(32), 'hex').toString('base64')}\n`,
    ),
  );

  const missingCustomerSecrets = CUSTOMER_SECRETS.filter(
    (name) => !existsSync(join(secretsDir, name)),
  );

  return { created, kept, missingCustomerSecrets };
}

/**
 * Creates a new file with mode 0600, or returns false when it already exists.
 * The content is produced only when the file is actually created, so an
 * existing release key is never regenerated.
 */
function writeNew(path: string, content: string | (() => string)): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, typeof content === 'string' ? content : content());
  } finally {
    closeSync(fd);
  }
  return true;
}

function readTrimmed(path: string): string {
  return readFileSync(path, 'utf8').trim();
}
