/**
 * Deployment mode and storage driver, parsed once and shared by env validation
 * and AppConfig so both answer the same way.
 *
 * These are a deployment axis, separate from ALPHACI_EDITION (which selects a
 * product composition). A self-hosted appliance runs the saas or enterprise
 * edition on its own Postgres; it is not a different product.
 */

export const DEPLOYMENT_MODES = ['saas', 'selfhosted'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const STORAGE_DRIVERS = ['postgres', 'supabase'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

type EnvLike = Readonly<Record<string, unknown>>;

function trimmedLower(env: EnvLike, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function nonBlank(env: EnvLike, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * ALPHACI_DEPLOYMENT_MODE. Unset means `saas`, which keeps every existing
 * deployment exactly as it was. `selfhosted` turns on the self-hosted rules in
 * env validation (postgres sessions, no Supabase, a public URL).
 */
export function parseDeploymentMode(env: EnvLike): DeploymentMode {
  const raw = trimmedLower(env, 'ALPHACI_DEPLOYMENT_MODE');
  if (raw === '') {
    return 'saas';
  }
  const mode = DEPLOYMENT_MODES.find((value) => value === raw);
  if (!mode) {
    throw new Error(
      `[config] Invalid ALPHACI_DEPLOYMENT_MODE: '${raw}'. ` +
        `Allowed values: ${DEPLOYMENT_MODES.join(', ')}. Default when unset: saas.`,
    );
  }
  return mode;
}

/**
 * STORAGE_DRIVER selects where QA screenshot bytes live.
 *
 *   postgres  bytea in projects.qa_attachment_objects, served by the backend.
 *   supabase  the private qa-attachments Storage bucket (service role key).
 *
 * Unset: `supabase` when SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is present
 * (SaaS, unchanged), otherwise `postgres`. Self-hosted always defaults to
 * `postgres`, and rejects `supabase` outright so a leftover SUPABASE_* value
 * cannot quietly route bytes to a hosted provider.
 */
export function resolveStorageDriver(
  env: EnvLike,
  mode: DeploymentMode,
): StorageDriver {
  const raw = trimmedLower(env, 'STORAGE_DRIVER');
  if (raw === '') {
    const supabaseEnvPresent =
      nonBlank(env, 'SUPABASE_URL') ||
      nonBlank(env, 'SUPABASE_SERVICE_ROLE_KEY');
    return mode === 'saas' && supabaseEnvPresent ? 'supabase' : 'postgres';
  }
  const driver = STORAGE_DRIVERS.find((value) => value === raw);
  if (!driver) {
    throw new Error(
      `[config] Invalid STORAGE_DRIVER: '${raw}'. ` +
        `Allowed values: ${STORAGE_DRIVERS.join(', ')}.`,
    );
  }
  if (mode === 'selfhosted' && driver === 'supabase') {
    throw new Error(
      '[config] STORAGE_DRIVER=supabase is not available when ALPHACI_DEPLOYMENT_MODE=selfhosted. Use STORAGE_DRIVER=postgres.',
    );
  }
  return driver;
}
