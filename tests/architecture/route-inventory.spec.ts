import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { createHttpApplication } from '../../src/main.js';

Object.assign(process.env, {
  NODE_ENV: 'test',
  SESSION_STORE_DRIVER: 'memory',
  SESSION_SECRET: 'test-only-session-secret-that-is-at-least-32-bytes',
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

function routeSet(document: OpenAPIObject): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => method !== 'parameters')
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

describe('HTTP route inventory', () => {
  it('matches the pre-consolidation route baseline exactly', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('AlphaCI route inventory').build(),
      );
      const actual = routeSet(document);
      const baseline = readFileSync(
        resolve(__dirname, '../../docs/architecture/route-inventory.baseline.txt'),
        'utf8',
      )
        .split(/\r?\n/)
        .filter(Boolean);

      expect(actual).toEqual(baseline);
    } finally {
      await app.close();
    }
  }, 60_000);
});
