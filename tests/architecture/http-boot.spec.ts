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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CI_STAGE_RESULTS_LOOKUP } =
  require('../../src/kernel/ports/ci-stage-results.port.js') as typeof import('../../src/kernel/ports/ci-stage-results.port.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PROJECT_VISIBILITY_LOOKUP } =
  require('../../src/kernel/ports/project-visibility.port.js') as typeof import('../../src/kernel/ports/project-visibility.port.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CiRunReportsRepository } =
  require('../../src/modules/pipelines/ci/infrastructure/ci-run-reports.repository.js') as typeof import('../../src/modules/pipelines/ci/infrastructure/ci-run-reports.repository.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ProjectsRepository } =
  require('../../src/modules/projects/infrastructure/projects.repository.js') as typeof import('../../src/modules/projects/infrastructure/projects.repository.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AuditEventPublisher } =
  require('../../src/kernel/events/platform-event-publisher.js') as typeof import('../../src/kernel/events/platform-event-publisher.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QaAutomationDispatchService } =
  require('../../src/modules/projects/application/qa-runs/qa-automation-dispatch.service.js') as typeof import('../../src/modules/projects/application/qa-runs/qa-automation-dispatch.service.js');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QaCommitResolutionService } =
  require('../../src/modules/projects/application/qa-runs/qa-commit-resolution.service.js') as typeof import('../../src/modules/projects/application/qa-runs/qa-commit-resolution.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ProjectProvisioningApplicationService } =
  require('../../src/modules/projects/application/lifecycle/project-provisioning-application.service.js') as typeof import('../../src/modules/projects/application/lifecycle/project-provisioning-application.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NotificationEventPublisher } =
  require('../../src/kernel/events/platform-event-publisher.js') as typeof import('../../src/kernel/events/platform-event-publisher.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QaProjectRunsService } =
  require('../../src/modules/projects/application/qa-runs/qa-project-runs.service.js') as typeof import('../../src/modules/projects/application/qa-runs/qa-project-runs.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QaRequirementsService } =
  require('../../src/modules/projects/application/qa-checklists/qa-requirements.service.js') as typeof import('../../src/modules/projects/application/qa-checklists/qa-requirements.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QaProjectContextService } =
  require('../../src/modules/projects/application/qa-checklists/qa-project-context.service.js') as typeof import('../../src/modules/projects/application/qa-checklists/qa-project-context.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DELIVERY_PROJECT_DATA_CLEANUP } =
  require('../../src/kernel/ports/delivery-project-data-cleanup.port.js') as typeof import('../../src/kernel/ports/delivery-project-data-cleanup.port.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PROJECT_REQUIREMENTS_READINESS } =
  require('../../src/kernel/ports/project-requirements-readiness.port.js') as typeof import('../../src/kernel/ports/project-requirements-readiness.port.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ProjectRequirementsReadinessAdapter } =
  require('../../src/modules/projects/application/qa-checklists/project-requirements-readiness.adapter.js') as typeof import('../../src/modules/projects/application/qa-checklists/project-requirements-readiness.adapter.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RepositoriesService } =
  require('../../src/modules/identity-access/hierarchy/application/repositories.service.js') as typeof import('../../src/modules/identity-access/hierarchy/application/repositories.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ProjectFoldersService } =
  require('../../src/modules/identity-access/hierarchy/application/project-folders.service.js') as typeof import('../../src/modules/identity-access/hierarchy/application/project-folders.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DeliveryProjectsService } =
  require('../../src/modules/identity-access/hierarchy/application/delivery-projects.service.js') as typeof import('../../src/modules/identity-access/hierarchy/application/delivery-projects.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QaChecklistsService } =
  require('../../src/modules/projects/application/qa-checklists/qa-checklists.service.js') as typeof import('../../src/modules/projects/application/qa-checklists/qa-checklists.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ProjectWorkflowsService } =
  require('../../src/modules/projects/application/workflows/project-workflows.service.js') as typeof import('../../src/modules/projects/application/workflows/project-workflows.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QaPromotionService } =
  require('../../src/modules/projects/application/qa-runs/qa-promotion.service.js') as typeof import('../../src/modules/projects/application/qa-runs/qa-promotion.service.js');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { APP_ROLE_LOOKUP } =
  require('../../src/kernel/ports/app-role.port.js') as typeof import('../../src/kernel/ports/app-role.port.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CustomDomainsService } =
  require('../../src/modules/runtime/application/custom-domains.service.js') as typeof import('../../src/modules/runtime/application/custom-domains.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DeploymentTargetsService } =
  require('../../src/modules/runtime/application/deployment-targets.service.js') as typeof import('../../src/modules/runtime/application/deployment-targets.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ProviderConnectionsService } =
  require('../../src/modules/runtime/application/provider-connections.service.js') as typeof import('../../src/modules/runtime/application/provider-connections.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RepoConfigBrokerService } =
  require('../../src/modules/identity-access/hierarchy/application/repo-config-broker.service.js') as typeof import('../../src/modules/identity-access/hierarchy/application/repo-config-broker.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AssignmentsService } =
  require('../../src/modules/identity-access/hierarchy/application/assignments.service.js') as typeof import('../../src/modules/identity-access/hierarchy/application/assignments.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ExistingReposService } =
  require('../../src/modules/projects/application/existing-repos/existing-repos.service.js') as typeof import('../../src/modules/projects/application/existing-repos/existing-repos.service.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GithubController } =
  require('../../src/modules/pipelines/github/api/github.controller.js') as typeof import('../../src/modules/pipelines/github/api/github.controller.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DEPLOYMENT_PROJECT_REFERENCE_LOOKUP } =
  require('../../src/kernel/ports/deployment-runtime.port.js') as typeof import('../../src/kernel/ports/deployment-runtime.port.js');

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

  /*
   * QA automation (Slice 5) crosses the Pipelines/Projects boundary two
   * ways: CI_STAGE_RESULTS_LOOKUP (Pipelines -> Projects, the ordinary
   * direction ProjectsModule already imports CiModule for) and
   * PROJECT_VISIBILITY_LOOKUP (Projects -> Pipelines, the reverse direction,
   * which would cycle as a plain module import -- see
   * project-visibility.port.ts). Both ports only prove out at the real
   * composition root; a unit test that hands CiReportsService or
   * QaAutomationService a hand-built fake never exercises the module wiring
   * at all.
   */
  it('resolves CI_STAGE_RESULTS_LOOKUP to the real CI reports repository', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const lookup = app.get(CI_STAGE_RESULTS_LOOKUP, { strict: false });
      expect(lookup).toBeInstanceOf(CiRunReportsRepository);
      expect(typeof lookup.latestStageReports).toBe('function');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('resolves PROJECT_VISIBILITY_LOOKUP globally, without Pipelines importing Projects', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const lookup = app.get(PROJECT_VISIBILITY_LOOKUP, { strict: false });
      expect(lookup).toBeInstanceOf(ProjectsRepository);
      expect(typeof lookup.isRepoVisibleToUser).toBe('function');
    } finally {
      await app.close();
    }
  }, 60_000);

  /*
   * QaAutomationDispatchService's audit-event dependency is `@Optional()`
   * with NO explicit `@Inject()` token, injected by its concrete class type.
   * That pattern is only safe because the type IS the class: the sibling
   * pattern seen elsewhere in this codebase (`@Optional() dep?:
   * Pick<AuditEventPublisher, 'recordProjectEvent'>`, no `@Inject()`) was
   * verified during this slice to silently resolve to `undefined` even
   * though a real provider exists — TypeScript's decorator metadata erases
   * a type alias/mapped type to `Object`, which nothing provides, and
   * `@Optional()` swallows the failure instead of throwing. A passing boot
   * only proves the DI graph did not throw, not that each optional
   * dependency actually resolved — this reads the private field back out
   * (TS privacy is compile-time only) to prove it is the REAL provider,
   * not silently undefined.
   */
  it('gives QaAutomationDispatchService a real AuditEventPublisher, not a silently-undefined optional', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const auditEventPublisher = app.get(AuditEventPublisher, {
        strict: false,
      });
      const dispatchService = app.get(QaAutomationDispatchService, {
        strict: false,
      });
      const injected = (
        dispatchService as unknown as { auditEventsService?: unknown }
      ).auditEventsService;

      expect(auditEventPublisher).toBeInstanceOf(AuditEventPublisher);
      expect(injected).toBeInstanceOf(AuditEventPublisher);
      expect(injected).toBe(auditEventPublisher);
    } finally {
      await app.close();
    }
  }, 60_000);

  /*
   * Phase 2 notification fan-out depends on two things that unit tests build
   * by hand and a passing boot cannot prove: the commit-author lookup needs
   * the global platform-admin port, and project_created needs the real
   * NotificationEventPublisher inside the provisioning support object.
   */
  it('wires the returned-to-dev author lookup and the project_created fan-out', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      // Private fields are compile-time only; read them through `unknown`.
      const resolved: unknown = app.get(QaCommitResolutionService, {
        strict: false,
      });
      const resolution = resolved as {
        platformAdmin?: { findUserIdByGithubLogin?: unknown };
      };
      expect(typeof resolution.platformAdmin?.findUserIdByGithubLogin).toBe(
        'function',
      );

      const provisioningResolved: unknown = app.get(
        ProjectProvisioningApplicationService,
        { strict: false },
      );
      const provisioning = provisioningResolved as {
        support: { notificationEventPublisher?: unknown };
      };
      expect(provisioning.support.notificationEventPublisher).toBe(
        app.get(NotificationEventPublisher, { strict: false }),
      );
    } finally {
      await app.close();
    }
  }, 60_000);
  /*
   * The same silently-undefined optional, in services that already shipped:
   * their audit/notification sinks were typed with a Pick<> alias and no
   * @Inject token, so QA notifications (returned to dev, blocker, re-test,
   * signed off) and QA/workflow audit events never fired. Each is now
   * injected by an explicit token; this proves the REAL publishers arrive.
   */
  it.each([
    ['QaProjectRunsService', () => QaProjectRunsService, true],
    ['QaRequirementsService', () => QaRequirementsService, true],
    ['QaChecklistsService', () => QaChecklistsService, false],
    ['ProjectWorkflowsService', () => ProjectWorkflowsService, true],
    ['QaPromotionService', () => QaPromotionService, true],
  ] as const)(
    'gives %s its real audit (and notification) publishers',
    async (_name, service, hasNotifications) => {
      const app = await createHttpApplication();
      await app.init();

      try {
        // Private fields are compile-time only; read them through `unknown`.
        const resolved: unknown = app.get(service(), { strict: false });
        const instance = resolved as {
          auditEventsService?: unknown;
          notificationEventsService?: unknown;
        };
        expect(instance.auditEventsService).toBe(
          app.get(AuditEventPublisher, { strict: false }),
        );
        if (hasNotifications) {
          expect(instance.notificationEventsService).toBe(
            app.get(NotificationEventPublisher, { strict: false }),
          );
        }
      } finally {
        await app.close();
      }
    },
    60_000,
  );

  /*
   * Project requirements cross three boundaries that only prove out at the
   * composition root: PROJECT_LINK_PORT (a Project's repositories, owned by
   * identity-access) and DEPLOYMENT_TARGETS_QUERY (which repository is the
   * frontend, owned by runtime) feed QaProjectContextService, and
   * DELIVERY_PROJECT_DATA_CLEANUP (bound by projects, consumed by
   * identity-access when a Project is deleted) must resolve to the real
   * requirements service rather than arrive undefined.
   */
  /**
   * The Feature-before-repository rule: identity-access (hierarchy create,
   * project-folders) and the projects provisioning gate must resolve the REAL
   * readiness adapter, not an undefined from an @Optional dependency.
   */
  it('wires the Project requirements readiness port to its real implementation', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const readiness = app.get(PROJECT_REQUIREMENTS_READINESS, {
        strict: false,
      });
      expect(readiness).toBeInstanceOf(ProjectRequirementsReadinessAdapter);

      const repositories: unknown = app.get(RepositoriesService, {
        strict: false,
      });
      expect(
        (repositories as { requirementsReadiness?: unknown })
          .requirementsReadiness,
      ).toBe(readiness);
      const folders: unknown = app.get(ProjectFoldersService, {
        strict: false,
      });
      expect(
        (folders as { requirementsReadiness?: unknown }).requirementsReadiness,
      ).toBe(readiness);

      const provisioning: unknown = app.get(
        ProjectProvisioningApplicationService,
        { strict: false },
      );
      const support = (
        provisioning as {
          support: { requirementsReadiness?: unknown };
        }
      ).support;
      expect(support.requirementsReadiness).toBe(readiness);
    } finally {
      await app.close();
    }
  });

  it('wires the Project context ports and the Project delete cleanup', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const context: unknown = app.get(QaProjectContextService, {
        strict: false,
      });
      const wired = context as {
        projectLink?: {
          getDeliveryProject?: unknown;
          listDeliveryProjectsForGroup?: unknown;
        };
        deploymentTargets?: { listDeploymentTargets?: unknown };
      };
      expect(typeof wired.projectLink?.getDeliveryProject).toBe('function');
      expect(typeof wired.projectLink?.listDeliveryProjectsForGroup).toBe(
        'function',
      );
      expect(typeof wired.deploymentTargets?.listDeploymentTargets).toBe(
        'function',
      );

      const cleanup = app.get(DELIVERY_PROJECT_DATA_CLEANUP, { strict: false });
      expect(cleanup).toBe(app.get(QaRequirementsService, { strict: false }));

      const deliveryProjects: unknown = app.get(DeliveryProjectsService, {
        strict: false,
      });
      expect(
        (deliveryProjects as { deliveryProjectDataCleanup?: unknown })
          .deliveryProjectDataCleanup,
      ).toBe(cleanup);
    } finally {
      await app.close();
    }
  }, 60_000);

  /*
   * Phase 5 role gates. Each of these reads the caller's global app_role
   * through APP_ROLE_LOOKUP (and custom domains also checks project
   * visibility through DEPLOYMENT_PROJECT_REFERENCE_LOOKUP). A gate whose
   * lookup silently arrived as undefined would be a no-op or a permanent
   * refusal that unit tests, which hand-build the service, cannot see.
   */
  it.each([
    ['CustomDomainsService', () => CustomDomainsService],
    ['DeploymentTargetsService', () => DeploymentTargetsService],
    ['ProviderConnectionsService', () => ProviderConnectionsService],
    ['RepoConfigBrokerService', () => RepoConfigBrokerService],
    ['AssignmentsService', () => AssignmentsService],
    ['ExistingReposService', () => ExistingReposService],
    ['GithubController', () => GithubController],
  ] as const)(
    'gives %s the real APP_ROLE_LOOKUP, not a silently-undefined optional',
    async (_name, target) => {
      const app = await createHttpApplication();
      await app.init();

      try {
        const lookup = app.get(APP_ROLE_LOOKUP, { strict: false });
        expect(lookup).toBeInstanceOf(ProjectsRepository);
        const resolved: unknown = app.get(target(), { strict: false });
        const instance = resolved as { appRoleLookup?: unknown };
        expect(instance.appRoleLookup).toBe(lookup);
      } finally {
        await app.close();
      }
    },
    60_000,
  );

  it('gives CustomDomainsService the real project-visibility reference lookup', async () => {
    const app = await createHttpApplication();
    await app.init();

    try {
      const lookup = app.get(DEPLOYMENT_PROJECT_REFERENCE_LOOKUP, {
        strict: false,
      });
      const resolved: unknown = app.get(CustomDomainsService, {
        strict: false,
      });
      const instance = resolved as { projectReferenceLookup?: unknown };
      expect(
        typeof (lookup as { findProjectReference?: unknown })
          .findProjectReference,
      ).toBe('function');
      expect(instance.projectReferenceLookup).toBe(lookup);
    } finally {
      await app.close();
    }
  }, 60_000);
});
