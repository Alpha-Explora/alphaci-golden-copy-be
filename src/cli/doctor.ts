import { createPublicKey } from 'node:crypto';

import { validateCiApiConnectivity } from '../kernel/config/ci-api-connectivity';
import {
  planMigrations,
  type MigrationFile,
} from '../scripts/selfhost-migrations';

import { p256KeyProblem, releaseKeyId } from './release-key';
import { deriveUrls } from './selfhost-init';

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Everything doctor reads from outside the process. Injected so tests can fake it. */
export interface DoctorProbes {
  /** Connects and runs a trivial query. Throws when the database is unreachable. */
  checkDatabase(): Promise<void>;
  /** The applied-migration ledger: version to checksum. */
  readLedger(): Promise<ReadonlyMap<string, string>>;
  listMigrations(): readonly MigrationFile[];
  readFile(path: string): string;
  /** Resolves with the HTTP status. Rejects when the host cannot be reached. */
  probeHttps(url: string): Promise<number>;
}

/** Settings that must hold one exact value in the self-hosted profile. */
const EXACT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['NODE_ENV', 'production'],
  ['ALPHACI_EDITION', 'enterprise'],
  ['ALPHACI_BUILD_PROFILE', 'enterprise'],
  ['ALPHACI_DEPLOYMENT_MODE', 'selfhosted'],
  ['SUBSCRIPTION_GATE_ENABLED', 'false'],
  ['TRUST_PROXY_HOPS', '1'],
  ['SESSION_SECURE', 'true'],
  ['STORAGE_DRIVER', 'postgres'],
  ['ALPHACI_RELEASE_SIGNER', 'file'],
];

/**
 * Settings that must be present and non-blank. Secret-valued entries are named
 * here, but their values never reach the output. Values reach the process
 * through the *_FILE loader before doctor runs.
 */
const PRESENT_SETTINGS: readonly string[] = [
  'ALPHACI_HOSTNAME',
  'PLATFORM_PUBLIC_URL',
  'FRONTEND_URL',
  'ALLOWED_ORIGINS',
  'GITHUB_CALLBACK_URL',
  'ALPHACI_RELEASE_SIGNING_KEY_FILE',
  'GITHUB_CLIENT_ID',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_ENFORCED_ORG',
  'DATABASE_URL',
  'SESSION_SECRET',
  'ENV_PROVISIONING_ENCRYPTION_KEY',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
];

/** Setting names that are not set, or set to a value the profile does not allow. */
export function settingProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  for (const name of PRESENT_SETTINGS) {
    if (blank(env[name])) problems.push(`${name} is not set`);
  }
  for (const [name, expected] of EXACT_SETTINGS) {
    const actual = env[name]?.trim();
    if (actual !== expected) {
      problems.push(
        `${name} must be "${expected}"` +
          (blank(actual) ? ' (not set)' : ` (is "${actual}")`),
      );
    }
  }
  const session = env['SESSION_SECRET'];
  if (!blank(session) && (session as string).trim().length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters');
  }
  return problems;
}

/** Public URLs that do not match ALPHACI_HOSTNAME. Empty when the hostname itself is missing. */
export function derivedUrlProblems(env: NodeJS.ProcessEnv): string[] {
  const hostname = env['ALPHACI_HOSTNAME']?.trim();
  if (blank(hostname)) return [];
  const expected = deriveUrls(hostname as string);
  const pairs: ReadonlyArray<readonly [string, string | undefined, string]> = [
    [
      'PLATFORM_PUBLIC_URL',
      env['PLATFORM_PUBLIC_URL'],
      expected.platformPublicUrl,
    ],
    ['FRONTEND_URL', env['FRONTEND_URL'], expected.frontendUrl],
    ['ALLOWED_ORIGINS', env['ALLOWED_ORIGINS'], expected.allowedOrigins],
    [
      'GITHUB_CALLBACK_URL',
      env['GITHUB_CALLBACK_URL'],
      expected.githubCallbackUrl,
    ],
  ];
  return pairs
    .filter(([, actual, want]) => actual?.trim() !== want)
    .map(
      ([name, , want]) =>
        `${name} should be ${want}, derived from ALPHACI_HOSTNAME`,
    );
}

/** Runs the reachability rule the generated CI preflight uses, on PLATFORM_PUBLIC_URL. */
export function publicApiCheck(env: NodeJS.ProcessEnv): CheckResult {
  const name = 'PLATFORM_PUBLIC_URL is HTTPS and reachable from GitHub runners';
  const url = env['PLATFORM_PUBLIC_URL']?.trim();
  if (blank(url))
    return { name, ok: false, detail: 'PLATFORM_PUBLIC_URL is not set' };
  try {
    validateCiApiConnectivity(url as string, 'github-hosted');
    return { name, ok: true, detail: url as string };
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message };
  }
}

/**
 * The release signing key: readable, a P-256 private key, and its key ID. The
 * key material itself is never returned.
 */
export function signingKeyCheck(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): CheckResult {
  const name = 'release signing key is readable and P-256';
  const path = env['ALPHACI_RELEASE_SIGNING_KEY_FILE']?.trim();
  if (blank(path)) {
    return {
      name,
      ok: false,
      detail: 'ALPHACI_RELEASE_SIGNING_KEY_FILE is not set',
    };
  }
  let pem: string;
  try {
    pem = readFile(path as string);
  } catch {
    return { name, ok: false, detail: `cannot read ${path as string}` };
  }
  const problem = p256KeyProblem(pem, 'ALPHACI_RELEASE_SIGNING_KEY_FILE');
  if (problem !== undefined) return { name, ok: false, detail: problem };
  return { name, ok: true, detail: `key ID ${releaseKeyId(pem)}` };
}

/**
 * On-prem host checks. They run only when ONPREM_RELEASES_ENABLED is exactly
 * "true", the same test the backend makes, and return nothing otherwise, so an
 * install without on-prem hosts sees no extra lines.
 */
export function onpremChecks(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): CheckResult[] {
  if (env['ONPREM_RELEASES_ENABLED'] !== 'true') return [];
  return [onpremSettingsCheck(env), onpremTrustKeyCheck(env, readFile)];
}

/** Settings enrollment and host deployments read, with the formats the backend accepts. */
export function onpremSettingsProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (env['ENV_PROVISIONING_ENABLED'] !== 'true') {
    problems.push(
      'ENV_PROVISIONING_ENABLED must be "true": releases, and so host deployments, need it',
    );
  }
  const url = env['ONPREM_INSTALLER_URL']?.trim();
  const sha = env['ONPREM_INSTALLER_SHA256']?.trim();
  const repo = env['ONPREM_INSTALLER_RELEASE_REPO']?.trim();
  const shaValid = sha !== undefined && /^[0-9a-f]{64}$/.test(sha);
  if (!blank(url)) {
    if (!(/^https:\/\//.test(url as string) && shaValid)) {
      problems.push(
        'ONPREM_INSTALLER_URL needs an https URL and ONPREM_INSTALLER_SHA256 with 64 lowercase hex characters',
      );
    }
  } else if (blank(repo)) {
    problems.push(
      'set ONPREM_INSTALLER_RELEASE_REPO to owner/repo, or ONPREM_INSTALLER_URL with ONPREM_INSTALLER_SHA256',
    );
  } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo as string)) {
    problems.push('ONPREM_INSTALLER_RELEASE_REPO must be owner/repo');
  } else if (!blank(sha) && !shaValid) {
    problems.push(
      'ONPREM_INSTALLER_SHA256 must be 64 lowercase hex characters',
    );
  }
  const version = env['ONPREM_INSTALLER_VERSION']?.trim();
  if (!blank(version) && !/^\d+\.\d+\.\d+$/.test(version as string)) {
    problems.push('ONPREM_INSTALLER_VERSION must be x.y.z');
  }
  return problems;
}

/** The key IDs in ALPHACI_RELEASE_TRUST_KEYS_JSON, or why enrollment would refuse them. */
export function trustKeyIds(
  json: string,
): { ids: string[] } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { problem: 'ALPHACI_RELEASE_TRUST_KEYS_JSON is not JSON' };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0
  ) {
    return {
      problem:
        'ALPHACI_RELEASE_TRUST_KEYS_JSON must be a non-empty object of key ID to PEM public key',
    };
  }
  for (const [id, pem] of Object.entries(parsed)) {
    if (
      !id ||
      typeof pem !== 'string' ||
      !pem.startsWith('-----BEGIN PUBLIC KEY-----')
    ) {
      return {
        problem: `trust entry ${id || '(blank)'} is not a PEM public key`,
      };
    }
    try {
      const key = createPublicKey(pem);
      if (
        key.asymmetricKeyType !== 'ec' ||
        key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      ) {
        return { problem: `trust entry ${id} is not a P-256 key` };
      }
    } catch {
      return { problem: `trust entry ${id} is not a readable PEM public key` };
    }
  }
  return { ids: Object.keys(parsed) };
}

/**
 * A key enrollment can hand out: the install's signing key when it signs with
 * the key file, or the listed trust keys otherwise. The key material is never
 * returned. The key ID is.
 */
export function onpremTrustKeyCheck(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): CheckResult {
  const name = 'release trust key for on-prem hosts is available';
  const trust = env['ALPHACI_RELEASE_TRUST_KEYS_JSON'];
  let trustIds: string[] = [];
  if (!blank(trust)) {
    const parsed = trustKeyIds(trust as string);
    if ('problem' in parsed) return { name, ok: false, detail: parsed.problem };
    trustIds = parsed.ids;
  }
  if (env['ALPHACI_RELEASE_SIGNER'] === 'file') {
    const signing = signingKeyCheck(env, readFile);
    if (!signing.ok) return { name, ok: false, detail: signing.detail };
    const also =
      trustIds.length > 0 ? `; also trusted: ${trustIds.join(', ')}` : '';
    return {
      name,
      ok: true,
      detail: `signing ${signing.detail}, trusted with ALPHACI_RELEASE_SIGNER=file${also}`,
    };
  }
  if (trustIds.length === 0) {
    return {
      name,
      ok: false,
      detail:
        'set ALPHACI_RELEASE_SIGNER=file, or list the signing key ID in ALPHACI_RELEASE_TRUST_KEYS_JSON',
    };
  }
  return { name, ok: true, detail: `trusted key IDs: ${trustIds.join(', ')}` };
}

function onpremSettingsCheck(env: NodeJS.ProcessEnv): CheckResult {
  const name = 'on-prem settings are present and valid';
  const problems = onpremSettingsProblems(env);
  return {
    name,
    ok: problems.length === 0,
    detail: problems.length === 0 ? 'all present' : problems.join('; '),
  };
}

/** Ledger against the migration files: nothing pending, nothing edited, no gaps. */
export function migrationsCheck(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<string, string>,
): CheckResult {
  const name = 'migrations are at head';
  try {
    const plan = planMigrations(files, applied);
    if (plan.pending.length > 0) {
      return {
        name,
        ok: false,
        detail: `${plan.pending.length} pending (next: ${plan.pending[0]?.relativePath}). Run the migrate service.`,
      };
    }
    const extra =
      plan.unknownRecorded.length > 0
        ? `; ${plan.unknownRecorded.length} recorded version(s) have no file in this image`
        : '';
    return { name, ok: true, detail: `${plan.alreadyApplied} applied${extra}` };
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message };
  }
}

/** Runs every check. A failing check never stops the others, so one run shows the whole picture. */
export async function runDoctor(
  env: NodeJS.ProcessEnv,
  probes: DoctorProbes,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const problems = settingProblems(env);
  results.push({
    name: 'required settings are present and match the self-hosted profile',
    ok: problems.length === 0,
    detail: problems.length === 0 ? 'all present' : problems.join('; '),
  });

  const derived = derivedUrlProblems(env);
  results.push({
    name: 'public URLs derive from ALPHACI_HOSTNAME',
    ok: derived.length === 0,
    detail: derived.length === 0 ? 'consistent' : derived.join('; '),
  });

  results.push(publicApiCheck(env));

  const dbName = 'database is reachable';
  let databaseUp = false;
  try {
    await probes.checkDatabase();
    databaseUp = true;
    results.push({ name: dbName, ok: true, detail: 'connected and queried' });
  } catch (error) {
    results.push({ name: dbName, ok: false, detail: describe(error) });
  }

  const migrationName = 'migrations are at head';
  if (databaseUp) {
    try {
      const applied = await probes.readLedger();
      results.push(migrationsCheck(probes.listMigrations(), applied));
    } catch (error) {
      results.push({
        name: migrationName,
        ok: false,
        detail: `cannot read the ledger (${describe(error)}). Run the migrate service first.`,
      });
    }
  } else {
    results.push({
      name: migrationName,
      ok: false,
      detail: 'not checked: the database is unreachable',
    });
  }

  results.push(signingKeyCheck(env, (path) => probes.readFile(path)));
  results.push(...onpremChecks(env, (path) => probes.readFile(path)));

  for (const host of ['api.github.com', 'ghcr.io']) {
    const url =
      host === 'ghcr.io' ? 'https://ghcr.io/v2/' : 'https://api.github.com/';
    const name = `outbound HTTPS to ${host}`;
    try {
      const status = await probes.probeHttps(url);
      results.push({ name, ok: true, detail: `HTTP ${String(status)}` });
    } catch (error) {
      results.push({
        name,
        ok: false,
        detail: `no response: ${describe(error)}`,
      });
    }
  }

  return results;
}

export function formatResults(results: readonly CheckResult[]): string {
  const lines = results.map(
    (result) =>
      `[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}: ${result.detail}`,
  );
  const failed = results.filter((result) => !result.ok).length;
  lines.push(
    failed === 0
      ? 'doctor: all checks passed'
      : `doctor: ${String(failed)} check(s) failed`,
  );
  return lines.join('\n');
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
