import request from 'supertest';

// Type-only: erased at compile time, so it cannot be hoisted above the
// environment fixture the way a value import would be.
import type { ProviderReleaserRegistryPort } from '../../src/modules/runtime/application/ports/provider-releaser.port';

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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DeploymentStrategyResolver } =
  require('../../src/modules/runtime/domain/deployment-strategy.resolver.js') as typeof import('../../src/modules/runtime/domain/deployment-strategy.resolver.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PROVIDER_RELEASER_REGISTRY } =
  require('../../src/modules/runtime/application/ports/provider-releaser.port.js') as typeof import('../../src/modules/runtime/application/ports/provider-releaser.port.js');
const { MemberDirectoryService, MemberDirectorySource } =
  require('../../src/modules/identity-access/directory/index.js') as typeof import('../../src/modules/identity-access/directory/index.js');

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

  /*
   * Proven against the booted application, not a hand-built instance.
   *
   * The resolver's unit tests pass a registry to its constructor directly, so
   * they passed the whole time Nest was building it with none: the resolver is
   * undecorated domain code, so as a plain provider it got no constructor
   * arguments. Every managed Render and Vercel target resolved to
   * `provider_native`, and no repository ever received a pipeline secret.
   * RuntimeModule now builds it with a factory; only the real composition root
   * can show that the wiring holds.
   */
  it('resolves managed hosting to the strategies the secrets installers act on', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const resolver = app.get(DeploymentStrategyResolver, { strict: false });

      expect(
        resolver.resolve({
          provider: 'vercel',
          ownershipMode: 'flowci_managed',
        }),
      ).toBe('vercel_ci_pushed');
      expect(
        resolver.resolve({
          provider: 'render',
          ownershipMode: 'flowci_managed',
        }),
      ).toBe('render_image_pushed');
    } finally {
      await app.close();
    }
  }, 60_000);

  /*
   * A provider pack that forgets its releaser is invisible until a deploy
   * silently never happens - the same shape as the resolver above, whose
   * missing registry cost every managed target its secrets. The registry is
   * built from the packs, so this asserts the composition, not a constant.
   */
  it('composes a releaser for the provider that needs one', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const releasers = app.get<ProviderReleaserRegistryPort>(
        PROVIDER_RELEASER_REGISTRY,
        { strict: false },
      );

      expect(releasers.get('render')).toBeDefined();
      // Vercel deploys from the pipeline itself, so it contributes none.
      expect(releasers.get('vercel')).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 60_000);

  /*
   * The directory source is chosen by a factory, the wiring that once cost
   * every managed target its secrets. Only the booted app shows the service
   * actually received a source, and that the default is the GitHub org.
   */
  it('composes the member directory with the GitHub org source by default', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const source = app.get(MemberDirectorySource, { strict: false });
      const service = app.get(MemberDirectoryService, { strict: false });

      expect(source.constructor.name).toBe('GithubOrgDirectorySource');
      expect(service.describe().source).toBe('github_org');
    } finally {
      await app.close();
    }
  }, 60_000);
});
