import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { OutboxDispatcher } from '#kernel/events/outbox-dispatcher';
import { OUTBOX_TOPICS } from '#kernel/events/outbox-topics';
import { AUDIT_LATEST_EVENT_QUERY_PORT } from '#kernel/ports/audit.port';
import { DELIVERY_PROJECT_OVERVIEW_QUERY } from '#kernel/ports/delivery-project-overview.port';
import { DELIVERY_PROJECT_REPOSITORY_PROVISIONING } from '#kernel/ports/delivery-project-repository-provisioning.port';
import { DeliveryProjectMembersService } from '../../src/modules/identity-access/hierarchy/application/delivery-project-members.service';
import { HierarchyProjectLinkService } from '../../src/modules/identity-access/hierarchy/project-link/application/hierarchy-project-link.service';
import { RepositoriesService } from '../../src/modules/identity-access/hierarchy/application/repositories.service';
import { GroupsService } from '../../src/modules/identity-access/hierarchy/application/groups.service';
import { OutboxRelayWorker } from '../../src/modules/platform-ops/application/outbox-relay.worker';
import { AuditEventsService } from '../../src/modules/platform-ops/audit/application/audit-events.service';
import { QaProjectContextService } from '../../src/modules/projects/application/qa-checklists/qa-project-context.service';
import { QaRequirementsService } from '../../src/modules/projects/application/qa-checklists/qa-requirements.service';
import { DeploymentProviderRegistry } from '../../src/modules/runtime/core/deployment-provider.registry';
import { RuntimeProviderPackRegistry } from '../../src/modules/runtime/core/provider-pack';
import { IdentityAccessModule } from '../../src/modules/identity-access/identity-access.module';
import { BillingModule } from '../../src/modules/billing/billing.module';
import { PipelinesModule } from '../../src/modules/pipelines/pipelines.module';
import { ProjectsModule } from '../../src/modules/projects/projects.module';
import { PLAYWRIGHT_LIVE_PORT } from '#kernel/ports/playwright-live.port';
import { PlaywrightLiveService } from '../../src/modules/pipelines/ci/application/playwright-live.service';
import { ProjectPlaywrightLiveService } from '../../src/modules/projects/application/playwright-live/project-playwright-live.service';
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
const { AppModule } =
  require('../../src/app.module.js') as typeof import('../../src/app.module.js');

/** A provider's private collaborators, read by name. */
function internals(instance: object): Record<string, Record<string, unknown>> {
  return instance as Record<string, Record<string, unknown>>;
}

describe('AppModule boot smoke', () => {
  it('keeps the six bounded-context roots at the application composition boundary', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const contextRoots = [
      IdentityAccessModule,
      BillingModule,
      PipelinesModule,
      ProjectsModule,
      RuntimeModule,
      PlatformOpsModule,
    ];

    expect(imports).toEqual(expect.arrayContaining(contextRoots));
    expect(
      imports.filter((entry) => contextRoots.includes(entry as never)),
    ).toHaveLength(contextRoots.length);
  });

  it('constructs the full Nest application without listening or a database', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const dispatcher = app.get(OutboxDispatcher);
    expect(dispatcher.topics().slice().sort()).toEqual(
      Object.values(OUTBOX_TOPICS).sort(),
    );
    expect(
      app
        .get(DeploymentProviderRegistry)
        .list()
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(['gcp', 'onprem-compose', 'render', 'vercel']);
    const providerPacks = app.get(RuntimeProviderPackRegistry);
    expect(
      providerPacks
        .list()
        .map((pack) => pack.id)
        .sort(),
    ).toEqual(['gcp', 'onprem-compose', 'render', 'vercel']);
    expect(providerPacks.get('render').client?.provider).toBe('render');
    expect(providerPacks.get('vercel').workflowFragment?.provider).toBe(
      'vercel',
    );
    expect(providerPacks.get('gcp').client).toBeUndefined();
    // Live Playwright progress: the Pipelines-owned port resolves to its real
    // service and Projects' read service constructs against it (an undecorated
    // or mis-wired provider would fail the app context above).
    expect(app.get(PLAYWRIGHT_LIVE_PORT, { strict: false })).toBeInstanceOf(
      PlaywrightLiveService,
    );
    expect(
      app.get(ProjectPlaywrightLiveService, { strict: false }),
    ).toBeInstanceOf(ProjectPlaywrightLiveService);
    await app.close();
  }, 30_000);

  /*
   * An @Optional() collaborator that is not bound resolves to undefined and
   * only fails at the first call (the QA notifications never fired that way).
   * Every collaborator the Project-membership flow adds must be a real provider
   * after boot, not undefined, and the cross-context port must reach Projects.
   */
  it('wires every Project-membership collaborator as a real provider', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const membersInstance = app.get(DeliveryProjectMembersService);
      const members = internals(membersInstance);
      for (const dependency of [
        'membersRepository',
        'deliveryProjectsRepository',
        'repositoriesRepository',
        'assignmentsRepository',
        'groupsRepository',
        'githubSyncService',
        'accessService',
        'databaseService',
        'configService',
        'auditEventsService',
        'appRoleLookup',
      ]) {
        expect([dependency, members[dependency]]).toEqual([
          dependency,
          expect.anything(),
        ]);
      }
      expect(typeof members['appRoleLookup']?.['findAppRole']).toBe('function');

      const repositories = internals(app.get(RepositoriesService));
      expect(
        typeof repositories['repositoryProvisioning']?.['provisionRepository'],
      ).toBe('function');
      expect(repositories['membersService']).toBe(membersInstance);
      expect(
        app.get(DELIVERY_PROJECT_REPOSITORY_PROVISIONING, { strict: false }),
      ).toBe(repositories['repositoryProvisioning']);

      const link = internals(app.get(HierarchyProjectLinkService));
      expect(link['projectMembers']).toBe(membersInstance);

      const groups = internals(app.get(GroupsService));
      expect(
        typeof groups['projectMembersRepository']?.[
          'markRemovedForUserInGroupWithClient'
        ],
      ).toBe('function');

      expect(app.get(OutboxRelayWorker)).toBeDefined();
    } finally {
      await app.close();
    }
  }, 30_000);

  /*
   * The team QA overview reads hierarchy facts and promotion merges through
   * cross-context ports. A collaborator that is not bound only fails at the
   * first overview call, which no unit test can see, so each one must be the
   * real provider after boot.
   */
  it('wires the QA team-overview collaborators as real providers', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const requirements = internals(
        app.get(QaRequirementsService, { strict: false }),
      );
      for (const dependency of [
        'checklists',
        'requirements',
        'projectRuns',
        'runs',
        'access',
        'projectContext',
        'auditQuery',
      ]) {
        expect([dependency, requirements[dependency]]).toEqual([
          dependency,
          expect.anything(),
        ]);
      }
      expect(
        typeof requirements['auditQuery']?.['findLatestProjectEventTimes'],
      ).toBe('function');
      expect(requirements['auditQuery']).toBe(
        app.get(AuditEventsService, { strict: false }),
      );

      const context = internals(
        app.get(QaProjectContextService, { strict: false }),
      );
      expect(typeof context['overviewQuery']?.['getOverviewFacts']).toBe(
        'function',
      );
      expect(context['overviewQuery']).toBe(
        app.get(HierarchyProjectLinkService),
      );
      expect(app.get(DELIVERY_PROJECT_OVERVIEW_QUERY, { strict: false })).toBe(
        context['overviewQuery'],
      );
      expect(
        app.get(AUDIT_LATEST_EVENT_QUERY_PORT, { strict: false }),
      ).toBeInstanceOf(AuditEventsService);
    } finally {
      await app.close();
    }
  }, 30_000);
});
