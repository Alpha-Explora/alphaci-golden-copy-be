import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { GithubModule } from '#modules/pipelines/github/github.module.js';
import { GithubService } from '#modules/pipelines/index.js';
import { NotificationsModule } from '#modules/platform-ops/notifications/notifications.module.js';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { UsageModule } from '#modules/billing/usage/usage.module.js';
import { WorkspacesModule } from '#modules/identity-access/workspaces/workspaces.module.js';
import { CiModule } from '#modules/pipelines/ci/ci.module.js';
import { DeploymentTargetsController } from './api/deployment-targets.controller';
import { EnvironmentDeploymentTargetsController } from './api/environment-deployment-targets.controller';
import { EnvironmentReleasesController } from './api/environment-releases.controller';
import { OnpremAgentController } from './api/onprem-agent.controller';
import { ProjectReleasesController } from './api/project-releases.controller';
import { ReleaseRegistryService } from './application/release-registry.service';
import { ReleaseRegistryRepository } from './infrastructure/repositories/release-registry.repository';
import { ENVIRONMENT_DEPLOYMENT_TARGET_RESOLVER } from '#kernel/ports/deployment-runtime.port';
import { DeploymentTargetsRepository } from './infrastructure/repositories/deployment-targets.repository';
import { DeploymentTargetsService } from './application/deployment-targets.service';
import {
  DEPLOYMENT_DRIFT_FINDINGS_STORE,
  DEPLOYMENT_DRIFT_QUERY,
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_HISTORY_QUERY,
  DEPLOYMENT_PROVISIONING_FACADE,
  DEPLOYMENT_TARGETS_QUERY,
  DEPLOYMENT_TARGET_DELETION,
  DEPLOYMENT_PROVIDER_RESOURCES_TEARDOWN,
} from './core/deployment-provisioning.contract';
import { DeploymentStrategyResolver } from './domain/deployment-strategy.resolver';
import { EnvTokenEncryptionService } from './application/encryption.service';
import { EnvVarsController } from './api/env-vars.controller';
import { EnvVarsRepository } from './infrastructure/repositories/env-vars.repository';
import { EnvVarsService } from './application/env-vars.service';
import { ProviderClientRegistry } from './infrastructure/providers/core/provider-client.registry';
import {
  PROVIDER_CI_SECRETS_INSTALLERS,
  PROVIDER_CI_SECRETS_INSTALLER_REGISTRY,
} from './application/ports/provider-ci-secrets-installer.port';
import {
  PROVIDER_RELEASERS,
  PROVIDER_RELEASER_REGISTRY,
} from './application/ports/provider-releaser.port';
import { ProviderReleaserRegistry } from './infrastructure/providers/core/provider-releaser.registry';
import { ReleasesController } from './api/releases.controller';
import { ReleasesService } from './application/releases.service';
import { RenderReleaseService } from './infrastructure/providers/render/render-release.service';
import { ProviderCiSecretsInstallerRegistry } from './infrastructure/providers/core/provider-ci-secrets.registry';
import { ProjectDeploymentProvisioningService } from './application/project-deployment-provisioning.service';
import { DeploymentProvisioningDefaultsService } from './application/deployment-provisioning-defaults.service';
import { RenderCiSecretsService } from './infrastructure/providers/render/render-ci-secrets.service';
import { RenderCostPolicyService } from './infrastructure/providers/render/render-cost-policy.service';
import { RenderEnvClient } from './infrastructure/providers/render/render-env.client';
import { ProviderConnectionsController } from './api/provider-connections.controller';
import { ProviderConnectionsRepository } from './infrastructure/repositories/provider-connections.repository';
import { ProviderConnectionsService } from './application/provider-connections.service';
import { CustomDomainsController } from './api/custom-domains.controller';
import { CustomDomainsRepository } from './infrastructure/repositories/custom-domains.repository';
import { CustomDomainsService } from './application/custom-domains.service';
import { VercelCiSecretsService } from './infrastructure/providers/vercel/vercel-ci-secrets.service';
import { VercelEnvClient } from './infrastructure/providers/vercel/vercel-env.client';
import { LegacyDeploymentProvidersModule } from './infrastructure/providers/legacy/legacy-deployment-providers.module';
import { LocalDeploymentHistoryProvider } from './application/local-deployment-history.provider';
import { ProjectDeploymentsService } from './application/project-deployments.service';
import { ProjectDriftService } from './application/project-drift.service';
import { ProjectSyncFindingsRepository } from './infrastructure/repositories/project-sync-findings.repository';
import { PROVIDER_CLIENT_REGISTRY } from './application/ports/provider-client-registry.port';
import { RuntimeCoreModule } from './core/runtime-core.module';
import { DeploymentProviderRegistry } from './core/deployment-provider.registry';
import { DEPLOYMENT_TARGET_DEFAULTS } from './core/deployment-provider.contract';
import { DEPLOYMENT_PROVISIONING_DEFAULTS } from './core/deployment-provisioning.defaults';
import { DeploymentProviderPolicyRegistry } from './domain/deployment-provider.policy';
import { RenderDeploymentPolicy } from './infrastructure/providers/render/render-deployment.policy';
import { VercelDeploymentPolicy } from './infrastructure/providers/vercel/vercel-deployment.policy';
import { RENDER_DEPLOYMENT_PROVIDER } from './infrastructure/providers/render/render-deployment.provider';
import { VERCEL_DEPLOYMENT_PROVIDER } from './infrastructure/providers/vercel/vercel-deployment.provider';
import { GcpDeploymentProvider } from './infrastructure/providers/gcp/gcp.provider';
import {
  RUNTIME_PROVIDER_PACKS,
  RuntimeProviderPackRegistry,
} from './core/provider-pack';
import type { DeploymentProvider } from './core/deployment-provider.contract';
import { createGcpProviderPack } from './infrastructure/providers/gcp/gcp-provider.pack';
import { OnpremComposeDeploymentProvider } from './infrastructure/providers/onprem/onprem-compose.provider';
import { createOnpremComposeProviderPack } from './infrastructure/providers/onprem/onprem-compose-provider.pack';
import { createRenderProviderPack } from './infrastructure/providers/render/render-provider.pack';
import { createVercelProviderPack } from './infrastructure/providers/vercel/vercel-provider.pack';
import {
  MANAGED_QUOTA_REGISTRAR,
  type ManagedQuotaRegistrar,
} from '#kernel/ports/usage-quota.port';
import {
  WORKFLOW_FRAGMENTS,
  WorkflowFragmentRegistry,
  type WorkflowFragment,
} from './core/workflow-fragment.contract';
import { GcpDeploymentModule } from './infrastructure/providers/gcp/gcp.module';
import {
  GITHUB_ACTIONS_SECRETS,
  type GithubActionsSecretsPort,
} from './application/ports/github-actions-secrets.port';

@Module({
  imports: [
    AuditModule,
    DatabaseModule,
    EventsModule,
    GithubModule,
    NotificationsModule,
    SubscriptionModule,
    UsageModule,
    WorkspacesModule,
    CiModule,
    LegacyDeploymentProvidersModule,
    RuntimeCoreModule,
    GcpDeploymentModule,
  ],
  controllers: [
    ReleasesController,
    ProviderConnectionsController,
    DeploymentTargetsController,
    EnvironmentDeploymentTargetsController,
    EnvironmentReleasesController,
    OnpremAgentController,
    ProjectReleasesController,
    EnvVarsController,
    CustomDomainsController,
  ],
  providers: [
    ProviderConnectionsRepository,
    DeploymentTargetsRepository,
    EnvVarsRepository,
    CustomDomainsRepository,
    CustomDomainsService,
    {
      provide: DEPLOYMENT_TARGETS_QUERY,
      useExisting: DeploymentTargetsRepository,
    },
    {
      provide: DEPLOYMENT_ENV_METADATA_QUERY,
      useExisting: EnvVarsRepository,
    },
    {
      provide: DEPLOYMENT_TARGET_DELETION,
      useExisting: DeploymentTargetsRepository,
    },
    ProviderConnectionsService,
    DeploymentTargetsService,
    ReleaseRegistryRepository,
    ReleaseRegistryService,
    {
      provide: ENVIRONMENT_DEPLOYMENT_TARGET_RESOLVER,
      useExisting: DeploymentTargetsService,
    },
    {
      provide: DEPLOYMENT_PROVIDER_RESOURCES_TEARDOWN,
      useExisting: DeploymentTargetsService,
    },
    {
      // A factory, not a plain provider: the resolver is undecorated domain
      // code, so Nest cannot see its constructor and would build it with no
      // registry - which resolves every target to provider_native and silently
      // skips installing its CI secrets. See tests/architecture/http-boot.spec.ts.
      provide: DeploymentStrategyResolver,
      useFactory: (
        providerRegistry: DeploymentProviderRegistry<DeploymentProvider>,
      ) => new DeploymentStrategyResolver(providerRegistry),
      inject: [DeploymentProviderRegistry],
    },
    {
      // Discoverable always; usable only where ONPREM_RELEASES_ENABLED turns
      // on-prem hosts on, so existing on-prem targets keep generating valid
      // pipelines even while the flag is off.
      provide: OnpremComposeDeploymentProvider,
      inject: [ConfigService, DeploymentProviderRegistry],
      useFactory: (
        configService: ConfigService,
        registry: DeploymentProviderRegistry,
      ) =>
        new OnpremComposeDeploymentProvider(
          configService.get<string>('ONPREM_RELEASES_ENABLED') === 'true',
          registry,
        ),
    },
    {
      provide: RUNTIME_PROVIDER_PACKS,
      useFactory: (
        renderProvider: DeploymentProvider,
        renderPolicy: RenderDeploymentPolicy,
        renderClient: RenderEnvClient,
        renderCiSecretsInstaller: RenderCiSecretsService,
        renderReleaser: RenderReleaseService,
        vercelProvider: DeploymentProvider,
        vercelPolicy: VercelDeploymentPolicy,
        vercelClient: VercelEnvClient,
        vercelCiSecretsInstaller: VercelCiSecretsService,
        gcpProvider: GcpDeploymentProvider,
        onpremProvider: OnpremComposeDeploymentProvider,
        workflowFragments: readonly WorkflowFragment[],
      ) => [
        createRenderProviderPack({
          provider: renderProvider,
          policy: renderPolicy,
          client: renderClient,
          workflowFragment: workflowFragments.find(
            (fragment) => fragment.provider === 'render',
          ),
          ciSecretsInstaller: renderCiSecretsInstaller,
          releaser: renderReleaser,
        }),
        createVercelProviderPack({
          provider: vercelProvider,
          policy: vercelPolicy,
          client: vercelClient,
          workflowFragment: workflowFragments.find(
            (fragment) => fragment.provider === 'vercel',
          ),
          ciSecretsInstaller: vercelCiSecretsInstaller,
        }),
        createGcpProviderPack({ provider: gcpProvider }),
        createOnpremComposeProviderPack({ provider: onpremProvider }),
      ],
      inject: [
        RENDER_DEPLOYMENT_PROVIDER,
        RenderDeploymentPolicy,
        RenderEnvClient,
        RenderCiSecretsService,
        RenderReleaseService,
        VERCEL_DEPLOYMENT_PROVIDER,
        VercelDeploymentPolicy,
        VercelEnvClient,
        VercelCiSecretsService,
        GcpDeploymentProvider,
        OnpremComposeDeploymentProvider,
        WORKFLOW_FRAGMENTS,
      ],
    },
    RuntimeProviderPackRegistry,
    {
      provide: DeploymentProviderPolicyRegistry,
      useFactory: (
        providerPacks: RuntimeProviderPackRegistry,
        usageQuotaRegistrar: ManagedQuotaRegistrar,
      ) => {
        const policies = providerPacks
          .list()
          .flatMap((pack) => (pack.policy ? [pack.policy] : []));
        for (const policy of policies) {
          if (policy.managedQuota) {
            usageQuotaRegistrar.registerManagedQuota({
              providerId: policy.providerId,
              ...policy.managedQuota,
            });
          }
        }
        return new DeploymentProviderPolicyRegistry(policies);
      },
      inject: [RuntimeProviderPackRegistry, MANAGED_QUOTA_REGISTRAR],
    },
    EnvVarsService,
    EnvTokenEncryptionService,
    {
      provide: GITHUB_ACTIONS_SECRETS,
      inject: [GithubService],
      useFactory: (githubService: GithubService): GithubActionsSecretsPort => ({
        setActionsSecretStrict: (...args) =>
          githubService.setActionsSecretStrict(...args),
        setActionsVariableStrict: (...args) =>
          githubService.setActionsVariableStrict(...args),
        ensureDeploymentEnvironment: (input) =>
          githubService.ensureDeploymentEnvironment(input),
        dispatchWorkflow: (input) => githubService.dispatchWorkflow(input),
      }),
    },
    {
      provide: ProviderClientRegistry,
      useFactory: (providerPacks: RuntimeProviderPackRegistry) =>
        new ProviderClientRegistry(
          providerPacks
            .list()
            .flatMap((pack) => (pack.client ? [pack.client] : [])),
        ),
      inject: [RuntimeProviderPackRegistry],
    },
    {
      provide: PROVIDER_CLIENT_REGISTRY,
      useExisting: ProviderClientRegistry,
    },
    {
      provide: PROVIDER_CI_SECRETS_INSTALLERS,
      useFactory: (providerPacks: RuntimeProviderPackRegistry) =>
        providerPacks
          .list()
          .flatMap((pack) =>
            pack.ciSecretsInstaller ? [pack.ciSecretsInstaller] : [],
          ),
      inject: [RuntimeProviderPackRegistry],
    },
    ProviderCiSecretsInstallerRegistry,
    RenderReleaseService,
    ReleasesService,
    {
      provide: PROVIDER_RELEASERS,
      useFactory: (providerPacks: RuntimeProviderPackRegistry) =>
        providerPacks
          .list()
          .flatMap((pack) => (pack.releaser ? [pack.releaser] : [])),
      inject: [RuntimeProviderPackRegistry],
    },
    ProviderReleaserRegistry,
    {
      provide: PROVIDER_RELEASER_REGISTRY,
      useExisting: ProviderReleaserRegistry,
    },
    {
      provide: PROVIDER_CI_SECRETS_INSTALLER_REGISTRY,
      useExisting: ProviderCiSecretsInstallerRegistry,
    },
    LocalDeploymentHistoryProvider,
    ProjectSyncFindingsRepository,
    ProjectDeploymentsService,
    {
      provide: DEPLOYMENT_HISTORY_QUERY,
      useExisting: ProjectDeploymentsService,
    },
    ProjectDriftService,
    {
      provide: DEPLOYMENT_DRIFT_QUERY,
      useExisting: ProjectDriftService,
    },
    {
      provide: DEPLOYMENT_DRIFT_FINDINGS_STORE,
      useExisting: ProjectSyncFindingsRepository,
    },
    ProjectDeploymentProvisioningService,
    DeploymentProvisioningDefaultsService,
    {
      provide: DEPLOYMENT_PROVISIONING_DEFAULTS,
      useExisting: DeploymentProvisioningDefaultsService,
    },
    {
      provide: DEPLOYMENT_PROVISIONING_FACADE,
      useExisting: ProjectDeploymentProvisioningService,
    },
    RenderCiSecretsService,
    {
      provide: DEPLOYMENT_TARGET_DEFAULTS,
      useExisting: RenderCostPolicyService,
    },
    {
      provide: WorkflowFragmentRegistry,
      useFactory: (providerPacks: RuntimeProviderPackRegistry) =>
        new WorkflowFragmentRegistry(
          providerPacks
            .list()
            .flatMap((pack) =>
              pack.workflowFragment ? [pack.workflowFragment] : [],
            ),
        ),
      inject: [RuntimeProviderPackRegistry],
    },
    VercelCiSecretsService,
    SessionAuthGuard,
    SubscriptionGuard,
  ],
  exports: [
    DEPLOYMENT_PROVISIONING_FACADE,
    DEPLOYMENT_HISTORY_QUERY,
    DEPLOYMENT_DRIFT_QUERY,
    DEPLOYMENT_DRIFT_FINDINGS_STORE,
    DEPLOYMENT_TARGETS_QUERY,
    DEPLOYMENT_ENV_METADATA_QUERY,
    DEPLOYMENT_TARGET_DELETION,
    DEPLOYMENT_PROVIDER_RESOURCES_TEARDOWN,
    ENVIRONMENT_DEPLOYMENT_TARGET_RESOLVER,
    PROVIDER_CLIENT_REGISTRY,
    PROVIDER_CI_SECRETS_INSTALLER_REGISTRY,
    WorkflowFragmentRegistry,
    // Nest can only re-export a bare token when it was also provided in this
    // module; DEPLOYMENT_PROVIDER_CATALOG is only ever provided inside
    // RuntimeCoreModule, so the whole module has to be re-exported instead.
    // This is what lets Projects read provider capability data (e.g. whether
    // a provider offers logs) through the RuntimeModule import it already
    // uses for deployment history, instead of importing RuntimeCoreModule a
    // second time.
    RuntimeCoreModule,
  ],
})
export class RuntimeModule {}
