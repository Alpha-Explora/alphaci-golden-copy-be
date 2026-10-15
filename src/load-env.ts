import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Loads the same env files ConfigModule reads, before AppModule is imported.
 * Some modules derive values from process.env at import time (the generated CI
 * workflow's public API URL), which runs before ConfigModule loads `.env`, so
 * they otherwise fall back to localhost. Order and precedence match
 * ConfigModule: `.env.local` before `.env`, and variables already set in the
 * environment win.
 */
export function loadEnvFiles(
  files: readonly string[] = ['.env.local', '.env'],
  env: NodeJS.ProcessEnv = process.env,
): void {
  // The E2E suite keeps local credentials out of test runs (see app.module.ts).
  if (env['ALPHACI_IGNORE_ENV_FILE'] === 'true') return;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values))
      if (env[key] === undefined) env[key] = value;
  }
}
