import 'reflect-metadata';

import { IdentityAccessModule } from '../../src/modules/identity-access/identity-access.module';
import { BillingModule } from '../../src/modules/billing/billing.module';
import { PipelinesModule } from '../../src/modules/pipelines/pipelines.module';
import { ProjectsModule } from '../../src/modules/projects/projects.module';
import { RuntimeModule } from '../../src/modules/runtime/runtime.module';
import { PlatformOpsModule } from '../../src/modules/platform-ops/platform-ops.module';

Object.assign(process.env, {
  NODE_ENV: 'test',
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../../src/app.module.js') as typeof import('../../src/app.module.js');

describe('application context roots', () => {
  it('composes the six bounded contexts through their root modules', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(imports).toEqual(
      expect.arrayContaining([
        IdentityAccessModule,
        BillingModule,
        PipelinesModule,
        ProjectsModule,
        RuntimeModule,
        PlatformOpsModule,
      ]),
    );
  });
});
