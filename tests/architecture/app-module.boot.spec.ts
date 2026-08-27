import { NestFactory } from '@nestjs/core';
import { OutboxDispatcher } from '#kernel/events/outbox-dispatcher';
import { HIERARCHY_OUTBOX_TOPICS } from '#modules/identity-access/hierarchy/hierarchy.types';
import { PLATFORM_EVENT_TOPICS } from '#kernel/events/platform-event.registry';

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
const { AppModule } =
  require('../../src/app.module.js') as typeof import('../../src/app.module.js');

describe('AppModule boot smoke', () => {
  it('constructs the full Nest application without listening or a database', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const dispatcher = app.get(OutboxDispatcher);
    expect(dispatcher.topics()).toEqual(
      expect.arrayContaining([
        PLATFORM_EVENT_TOPICS.auditRecorded,
        PLATFORM_EVENT_TOPICS.notificationRequested,
        HIERARCHY_OUTBOX_TOPICS.grant,
        HIERARCHY_OUTBOX_TOPICS.revoke,
      ]),
    );
    await app.close();
  }, 30_000);
});
