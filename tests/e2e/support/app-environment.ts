/**
 * Runs before each E2E test file imports the application. Every setting the
 * app reads comes from here: env files are ignored and provider credentials a
 * developer's shell may export are removed.
 */
const PROVIDER_CREDENTIALS =
  /^(ALPHACI_RENDER_|ALPHACI_VERCEL_|GITHUB_APP_|RENDER_|VERCEL_|KAFKA_|SUPABASE_DB_CA_CERT$)/;

for (const key of Object.keys(process.env)) {
  if (PROVIDER_CREDENTIALS.test(key)) delete process.env[key];
}

const databaseUrl = process.env['E2E_APP_DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('E2E global setup did not provide E2E_APP_DATABASE_URL.');
}

Object.assign(process.env, {
  ALPHACI_IGNORE_ENV_FILE: 'true',
  NODE_ENV: 'development',
  DEV_QUICK_LOGIN: 'true',
  SESSION_SECRET: 'e2e-only-session-secret-that-is-at-least-32-bytes',
  SESSION_STORE_DRIVER: 'memory',
  SESSION_SECURE: 'false',
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_ANON_KEY: 'e2e-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'e2e-service-role-key',
  SUPABASE_DB_URL: databaseUrl,
  ALLOWED_ORIGINS: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  GITHUB_CLIENT_ID: 'e2e-client-id',
  GITHUB_CLIENT_SECRET: 'e2e-client-secret',
  // Deployment targets are reachable; every provider client is a fake, so
  // these managed-account values are placeholders that never leave the test.
  ENV_PROVISIONING_ENABLED: 'true',
  ALPHACI_RENDER_API_KEY: 'e2e-render-token',
  ALPHACI_RENDER_OWNER_ID: 'e2e-render-owner',
  ENV_PROVISIONING_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
});
