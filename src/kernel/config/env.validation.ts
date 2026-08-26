/**
 * env.validation.ts
 *
 * Environment variable validation for ConfigModule.
 *
 * Usage in AppModule:
 *
 *   ConfigModule.forRoot({ validate: validateEnv })
 *
 * Design notes:
 *   - Uses a plain validate function — no Joi or class-validator runtime
 *     dependency needed. The check runs once at bootstrap.
 *   - Required vars cause a hard crash (fail-fast). Missing required config
 *     in a running service is a security risk: the service may silently fall
 *     back to insecure defaults.
 *
 * Threat addressed:
 *   - Service starting with missing secrets and silently degrading to
 *     insecure fallback behaviour (e.g. empty SUPABASE_SERVICE_ROLE_KEY
 *     allowing unauthenticated DB operations, or no ALLOWED_ORIGINS
 *     causing permissive CORS).
 */

export interface EnvironmentVariables {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  ENABLE_SWAGGER: string;
  SESSION_SECRET: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_DB_CA_CERT?: string;
  ALLOWED_ORIGINS: string;
  ENV_PROVISIONING_ENABLED?: string;
  ENV_PROVISIONING_ENCRYPTION_KEY?: string;
  ALPHACI_RENDER_API_KEY?: string;
  ALPHACI_RENDER_OWNER_ID?: string;
  ALPHACI_RENDER_DEFAULT_REGION?: string;
  ALPHACI_RENDER_DEFAULT_INSTANCE_TYPE?: string;
  ALPHACI_RENDER_ALLOWED_INSTANCE_TYPES?: string;
  ALPHACI_RENDER_ALLOW_PAID_MANAGED?: string;
  ALPHACI_RENDER_MANAGED_MAX_SERVICES_PER_USER?: string;
  ALPHACI_RENDER_BOOTSTRAP_IMAGE?: string;
  ALPHACI_RENDER_REGISTRY_CREDENTIAL_ID?: string;
  ALPHACI_RENDER_REGISTRY_USERNAME?: string;
  ALPHACI_RENDER_REGISTRY_TOKEN?: string;
  ALPHACI_VERCEL_TOKEN?: string;
  ALPHACI_VERCEL_TEAM_ID?: string;
  ALPHACI_VERCEL_TEAM_SLUG?: string;
  ALPHACI_SONAR_TOKEN?: string;
  ALPHACI_SONAR_ORGANIZATION?: string;
  FLOWCI_RENDER_API_KEY?: string;
  FLOWCI_RENDER_OWNER_ID?: string;
  FLOWCI_RENDER_DEFAULT_REGION?: string;
  FLOWCI_RENDER_DEFAULT_INSTANCE_TYPE?: string;
  FLOWCI_RENDER_ALLOWED_INSTANCE_TYPES?: string;
  FLOWCI_RENDER_ALLOW_PAID_MANAGED?: string;
  FLOWCI_RENDER_MANAGED_MAX_SERVICES_PER_USER?: string;
  FLOWCI_RENDER_BOOTSTRAP_IMAGE?: string;
  FLOWCI_RENDER_REGISTRY_CREDENTIAL_ID?: string;
  FLOWCI_RENDER_REGISTRY_USERNAME?: string;
  FLOWCI_RENDER_REGISTRY_TOKEN?: string;
  FLOWCI_VERCEL_TOKEN?: string;
  FLOWCI_VERCEL_TEAM_ID?: string;
  FLOWCI_VERCEL_TEAM_SLUG?: string;
  FLOWCI_SONAR_TOKEN?: string;
  FLOWCI_SONAR_ORGANIZATION?: string;
}

type RawEnv = Record<string, unknown>;
const SCOPED_SUPABASE_URL_SUFFIX = '_SUPABASE_URL';
const SCOPED_SUPABASE_SECRET_SUFFIXES = [
  '_SUPABASE_SECRET_KEY',
  '_SUPABASE_SERVICE_ROLE_KEY',
] as const;

function getTrimmedString(env: RawEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return undefined;
}

function extractScopedPrefix(key: string, suffix: string): string | null {
  if (!key.endsWith(suffix)) {
    return null;
  }

  const prefix = key.slice(0, -suffix.length);
  return prefix || null;
}

function getScopedSecretPrefix(key: string): string | null {
  for (const suffix of SCOPED_SUPABASE_SECRET_SUFFIXES) {
    const prefix = extractScopedPrefix(key, suffix);
    if (prefix) {
      return prefix;
    }
  }

  return null;
}

function collectScopedSupabasePrefixSets(env: RawEnv): {
  urlPrefixes: Set<string>;
  secretPrefixes: Set<string>;
} {
  const urlPrefixes = new Set<string>();
  const secretPrefixes = new Set<string>();

  for (const [key, raw] of Object.entries(env)) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      continue;
    }

    const urlPrefix = extractScopedPrefix(key, SCOPED_SUPABASE_URL_SUFFIX);
    if (urlPrefix) {
      urlPrefixes.add(urlPrefix);
    }

    const secretPrefix = getScopedSecretPrefix(key);
    if (secretPrefix) {
      secretPrefixes.add(secretPrefix);
    }
  }

  return { urlPrefixes, secretPrefixes };
}

function countScopedSupabaseClients(env: RawEnv): number {
  const { urlPrefixes, secretPrefixes } = collectScopedSupabasePrefixSets(env);

  let count = 0;
  for (const prefix of urlPrefixes) {
    if (secretPrefixes.has(prefix)) {
      count += 1;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Require SESSION_SECRET to be present and at least 32 characters long.
 * Extracted into its own function to keep validateEnv's cognitive complexity
 * within the project limit (≤ 15).
 */
function requireSessionSecret(env: RawEnv): string {
  const raw = env['SESSION_SECRET'];
  if (typeof raw !== 'string' || raw.trim().length < 32) {
    throw new Error(
      '[env] SESSION_SECRET must be set and at least 32 characters long. ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return raw.trim();
}

function requireString(env: RawEnv, key: string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `[env] Missing required environment variable: ${key}. ` +
        `Set it in .env or your deployment secrets before starting the service.`,
    );
  }
  return value.trim();
}

function requireStringFromAny(env: RawEnv, keys: string[]): string {
  const value = getTrimmedString(env, keys);
  if (!value) {
    throw new Error(
      `[env] Missing required environment variable: ${keys[0]}` +
        (keys.length > 1 ? ` (or alias ${keys.slice(1).join(', ')})` : '') +
        `. Set it in .env or your deployment secrets before starting the service.`,
    );
  }
  return value;
}

function requireEnum<T extends string>(
  env: RawEnv,
  key: string,
  allowed: readonly T[],
): T {
  const raw = requireString(env, key);
  if (!allowed.includes(raw as T)) {
    throw new Error(
      `[env] Invalid value for ${key}: '${raw}'. ` +
        `Allowed values: ${allowed.join(', ')}.`,
    );
  }
  return raw as T;
}

function requirePort(env: RawEnv, key: string, defaultValue = 4000): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    const display =
      typeof raw === 'string' ||
      typeof raw === 'number' ||
      typeof raw === 'boolean'
        ? String(raw)
        : JSON.stringify(raw);
    throw new Error(
      `[env] ${key} must be an integer between 1 and 65535. Got: '${display}'.`,
    );
  }
  return parsed;
}

function validateEnvProvisioningConfig(env: RawEnv): void {
  if (env['ENV_PROVISIONING_ENABLED'] !== 'true') {
    return;
  }

  const rawKey = requireString(env, 'ENV_PROVISIONING_ENCRYPTION_KEY');
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32) {
    throw new Error(
      '[env] ENV_PROVISIONING_ENCRYPTION_KEY must be a base64-encoded 32-byte key.',
    );
  }
}

function validateProductionGithubAppConfig(env: RawEnv): void {
  if (env['NODE_ENV'] !== 'production') return;

  // Accept the same alias names as app.config.ts (GITHUB_APP for the App ID,
  // GITHUB_PRIVATE_KEY for the key). If this gate rejects a name that
  // app.config.ts would honor at runtime, a correctly configured deployment
  // crash-loops at boot and the platform keeps serving the previous release.
  const appId = requireStringFromAny(env, ['GITHUB_APP_ID', 'GITHUB_APP']);
  const appSlug = requireString(env, 'GITHUB_APP_SLUG');
  const privateKey = requireStringFromAny(env, [
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_PRIVATE_KEY',
  ]).replaceAll('\\n', '\n');

  if (!/^\d+$/.test(appId)) {
    throw new Error('[env] GITHUB_APP_ID must contain digits only.');
  }
  if (
    appSlug === 'my-github-app' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(appSlug)
  ) {
    throw new Error(
      '[env] GITHUB_APP_SLUG must be the real GitHub App slug, not the placeholder my-github-app.',
    );
  }
  if (
    !privateKey.includes('-----BEGIN') ||
    !privateKey.includes('PRIVATE KEY-----')
  ) {
    throw new Error(
      '[env] GITHUB_APP_PRIVATE_KEY must contain a PEM-encoded private key.',
    );
  }
}

// ---------------------------------------------------------------------------
// Exported validate function
// ---------------------------------------------------------------------------

/**
 * validateEnv — passed directly to ConfigModule.forRoot({ validate }).
 *
 * Called by NestJS at bootstrap with the raw process.env object.
 * Must return the parsed/typed config or throw to abort startup.
 */
export function validateEnv(env: RawEnv): EnvironmentVariables {
  // --- Required: service identity ---
  const NODE_ENV = requireEnum(env, 'NODE_ENV', [
    'development',
    'test',
    'production',
  ] as const);

  const PORT = requirePort(env, 'PORT');

  // --- Required: session secret (minimum length enforced) ---
  // A weak or missing SESSION_SECRET allows cookie forgery. We require it in
  // all environments (not just production) so that developers are never
  // unknowingly running with an insecure secret.
  const SESSION_SECRET = requireSessionSecret(env);

  const SUPABASE_URL = getTrimmedString(env, ['SUPABASE_URL']);
  const SUPABASE_ANON_KEY = getTrimmedString(env, ['SUPABASE_ANON_KEY']);
  const SUPABASE_SERVICE_ROLE_KEY = getTrimmedString(env, [
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);

  const scopedSupabaseClientCount = countScopedSupabaseClients(env);

  const defaultSupabaseValues = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
  };

  const missingDefaultSupabaseKeys = Object.entries(defaultSupabaseValues)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (
    missingDefaultSupabaseKeys.length === 3 &&
    scopedSupabaseClientCount === 0
  ) {
    throw new Error(
      '[env] Missing Supabase configuration. Provide SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY, or define at least one scoped client pair (<SERVICE>_SUPABASE_URL + <SERVICE>_SUPABASE_SECRET_KEY).',
    );
  }

  if (
    missingDefaultSupabaseKeys.length > 0 &&
    missingDefaultSupabaseKeys.length < 3
  ) {
    if (scopedSupabaseClientCount === 0) {
      throw new Error(
        `[env] Incomplete default Supabase configuration. Missing: ${missingDefaultSupabaseKeys.join(', ')}.`,
      );
    }

    console.warn(
      `[env] WARNING: Default SUPABASE_* config is incomplete (${missingDefaultSupabaseKeys.join(', ')}). Proceeding with scoped service clients only.`,
    );
  }

  // --- Required: CORS ---
  // ALLOWED_ORIGINS must be set; corsOptions() will deny all browser-origin
  // requests if empty, which may cause confusing CORS errors in staging.
  // We require it here so misconfiguration is explicit at startup.
  const ALLOWED_ORIGINS = requireString(env, 'ALLOWED_ORIGINS');

  // --- Required: frontend URL ---
  // FRONTEND_URL is the redirect target after OAuth. If missing, every login
  // silently redirects to localhost:3000 — invisible in logs, fatal in prod.
  requireString(env, 'FRONTEND_URL');

  // --- Required: GitHub OAuth credentials ---
  // Both must be set; a missing secret causes silent login failure at runtime
  // rather than a hard crash at startup.
  requireString(env, 'GITHUB_CLIENT_ID');
  requireString(env, 'GITHUB_CLIENT_SECRET');
  validateProductionGithubAppConfig(env);

  // --- Optional ---
  const ENABLE_SWAGGER =
    (env['ENABLE_SWAGGER'] as string | undefined) ?? 'false';
  validateEnvProvisioningConfig(env);

  // Pass all raw env vars through first so appConfig and other factories can
  // read variables (e.g. GITHUB_CLIENT_ID) that validateEnv does not explicitly
  // validate. Without this, @nestjs/config's assignVariablesToProcess only sets
  // the keys returned here, leaving everything else missing from process.env.
  return {
    ...(env as unknown as EnvironmentVariables),
    NODE_ENV,
    PORT,
    ENABLE_SWAGGER,
    SESSION_SECRET,
    ...(SUPABASE_URL ? { SUPABASE_URL } : {}),
    ...(SUPABASE_ANON_KEY ? { SUPABASE_ANON_KEY } : {}),
    ...(SUPABASE_SERVICE_ROLE_KEY ? { SUPABASE_SERVICE_ROLE_KEY } : {}),
    ALLOWED_ORIGINS,
  };
}
