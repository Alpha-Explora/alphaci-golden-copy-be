import request from 'supertest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-only-session-secret-that-is-at-least-32-bytes',
  SESSION_STORE_DRIVER: 'memory',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  ENV_PROVISIONING_ENABLED: 'false',
  ENV_PROVISIONING_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
});

// Keep the environment setup above the application import. `app.module.ts`
// validates required configuration at module evaluation time, so a static
// ESM import would be hoisted before the architecture fixture is installed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHttpApplication } =
  require('../../src/main.js') as typeof import('../../src/main.js');

describe('HTTP application boot', () => {
  it('initializes the real Express middleware and serves health without a DB', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('x-correlation-id', 'architecture-smoke-correlation-id');

      expect([200, 503]).toContain(response.status);
      expect(response.headers['x-correlation-id']).toBe(
        'architecture-smoke-correlation-id',
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      if (response.status === 200) {
        expect(response.body).toEqual(
          expect.objectContaining({
            status: expect.any(String),
            checks: expect.any(Object),
          }),
        );
      } else {
        // The architecture environment intentionally has no database URL.
        // Health correctly returns 503 in that case, through the global
        // exception filter, so assert the real error envelope rather than
        // weakening production health semantics just for this smoke test.
        expect(response.body).toEqual(
          expect.objectContaining({
            statusCode: 503,
            path: '/api/v1/health',
            correlationId: 'architecture-smoke-correlation-id',
          }),
        );
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});
