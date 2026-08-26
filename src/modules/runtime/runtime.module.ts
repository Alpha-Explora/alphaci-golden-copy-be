import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { GithubModule } from '#modules/pipelines/github/github.module.js';
import { NotificationsModule } from '#modules/platform-ops/notifications/notifications.module.js';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { UsageModule } from '#modules/billing/usage/usage.module.js';
import { WorkspacesModule } from '#modules/identity-access/workspaces/workspaces.module.js';
import { CiModule } from '#modules/pipelines/ci/ci.module.js';
import { DeploymentTargetsController } from './api/deployment-targets.controller';
import { DeploymentTargetsRepository } from './infrastructure/deployment-targets.repository';
import { DeploymentTargetsService } from './application/deployment-targets.service';
import {
  DEPLOYMENT_DRIFT_FINDINGS_STORE,
  DEPLOYMENT_DRIFT_QUERY,
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_HISTORY_QUERY,
  DEPLOYMENT_PROVISIONING_FACADE,
  DEPLOYMENT_TARGETS_QUERY,
  DEPLOYMENT_TARGET_DELETION,
} from './core/deployment-provisioning.contract';
import { DeploymentStrategyResolver } from './domain/deployment-strategy.resolver';
import { EnvTokenEncryptionService } from './application/encryption.service';
import { EnvFeatureGuard } from './api/env-feature.guard';
import { EnvVarsController } from './api/env-vars.controller';
import { EnvVarsRepository } from './infrastructure/env-vars.repository';
import { EnvVarsService } from './application/env-vars.service';
import { ProviderClientRegistry } from './infrastructure/providers/core/provider-client.registry';
import { ProjectDeploymentProvisioningService } from './application/project-deployment-provisioning.service';
import { RenderCiSecretsService } from './application/render-ci-secrets.service';
import { RenderCostPolicyService } from './application/render-cost-policy.service';
import { RenderEnvClient } from './infrastructure/providers/render/render-env.client';
import { VercelEnvClient } from './infrastructure/providers/vercel/vercel-env.client';
import { ProviderConnectionsController } from './api/provider-connections.controller';
import { ProviderConnectionsRepository } from './infrastructure/provider-connections.repository';
import { ProviderConnectionsService } from './application/provider-connections.service';
import { CustomDomainsController } from './api/custom-domains.controller';
import { CustomDomainsRepository } from './infrastructure/custom-domains.repository';
import { CustomDomainsService } from './application/custom-domains.service';
import { VercelCiSecretsService } from './application/vercel-ci-secrets.service';
import { LegacyDeploymentProvidersModule } from './infrastructure/providers/legacy/legacy-deployment-providers.module';
import { LocalDeploymentHistoryProvider } from './application/local-deployment-history.provider';
import { ProjectDeploymentsService } from './application/project-deployments.service';
import { ProjectDriftService } from './application/project-drift.service';
import { ProjectSyncFindingsRepository } from './infrastructure/repositories/project-sync-findings.repository';
import { PROVIDER_CLIENT_REGISTRY } from './application/ports/provider-client-registry.port';

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
  ],
  controllers: [
    ProviderConnectionsController,
    DeploymentTargetsController,
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
    DeploymentStrategyResolver,
    EnvVarsService,
    EnvTokenEncryptionService,
    RenderEnvClient,
    VercelEnvClient,
    ProviderClientRegistry,
    {
      provide: PROVIDER_CLIENT_REGISTRY,
      useExisting: ProviderClientRegistry,
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
    {
      provide: DEPLOYMENT_PROVISIONING_FACADE,
      useExisting: ProjectDeploymentProvisioningService,
    },
    RenderCiSecretsService,
    RenderCostPolicyService,
    VercelCiSecretsService,
    EnvFeatureGuard,
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
    DeploymentTargetsRepository,
    EnvVarsRepository,
    CustomDomainsRepository,
    CustomDomainsService,
    ProviderConnectionsRepository,
    EnvTokenEncryptionService,
    ProviderClientRegistry,
    PROVIDER_CLIENT_REGISTRY,
  ],
})
export class RuntimeModule {}
