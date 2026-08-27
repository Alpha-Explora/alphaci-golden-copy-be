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

import { createHttpApplication } from '../../src/main.js';

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
      expect(response.body).toEqual(
        expect.objectContaining({
          status: expect.any(String),
          checks: expect.any(Object),
        }),
      );
    } finally {
      await app.close();
    }
  }, 60_000);
});
