import { readFileSync } from 'node:fs';

/**
 * Secrets that may be supplied as a file path instead of a value.
 *
 * `X_FILE=/run/secrets/x` makes `X` the trimmed contents of that file. The list
 * is explicit on purpose: a generic "any *_FILE" rule would let an environment
 * variable name a file the process then reads and copies into a setting, and
 * only the values below are meant to arrive that way.
 */
export const FILE_ENV_ALLOW_LIST: readonly string[] = [
  'DATABASE_URL',
  'SUPABASE_DB_URL',
  'SESSION_SECRET',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
  'ENV_PROVISIONING_ENCRYPTION_KEY',
];

export type ReadSecretFile = (path: string) => string;

/**
 * Resolves `X_FILE` into `X` for every allow-listed `X`, in place.
 *
 * Kernel code: it imports nothing from the modules, so the entry points that
 * run before AppModule (main.ts, the migration runner, the CLI) can call it.
 *
 * Fails closed. Setting both `X` and `X_FILE` is an error, because a silent
 * choice between them would hide which value the process is using. Errors name
 * the variable and the path, never the file's contents.
 */
export function applyFileEnv(
  env: NodeJS.ProcessEnv,
  allowList: readonly string[] = FILE_ENV_ALLOW_LIST,
  readSecretFile: ReadSecretFile = defaultReadSecretFile,
): void {
  for (const key of allowList) {
    const fileKey = `${key}_FILE`;
    const path = env[fileKey]?.trim();
    if (!path) continue;

    if (hasValue(env[key])) {
      throw new Error(
        `[config] ${key} and ${fileKey} are both set. Set only one of them.`,
      );
    }

    let value: string;
    try {
      value = readSecretFile(path).trim();
    } catch {
      throw new Error(
        `[config] ${fileKey} points to a file that cannot be read (${path}).`,
      );
    }
    if (value === '') {
      throw new Error(`[config] ${fileKey} points to an empty file (${path}).`);
    }
    env[key] = value;
  }
}

function hasValue(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== '';
}

function defaultReadSecretFile(path: string): string {
  return readFileSync(path, 'utf8');
}
