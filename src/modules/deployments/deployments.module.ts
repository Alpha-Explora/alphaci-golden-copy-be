import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../../kernel/db/database.module';
import { GithubModule } from '../github/github.module';
import { NotificationsModule } from '../notifications/index.js';
import { SubscriptionModule } from '../subscription/subscription.module';
import { UsageModule } from '../usage/usage.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { CiModule } from '../ci/index.js';
import { DeploymentTargetsController } from './deployment-targets.controller';
import { DeploymentTargetsRepository } from './deployment-targets.repository';
import { DeploymentTargetsService } from './deployment-targets.service';
import {
  DEPLOYMENT_DRIFT_FINDINGS_STORE,
  DEPLOYMENT_DRIFT_QUERY,
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_HISTORY_QUERY,
  DEPLOYMENT_PROVISIONING_FACADE,
  DEPLOYMENT_TARGETS_QUERY,
  DEPLOYMENT_TARGET_DELETION,
} from './deployment-provisioning.contract';
import { DeploymentStrategyResolver } from './deployment-strategy.resolver';
import { EnvTokenEncryptionService } from './encryption.service';
import { EnvFeatureGuard } from './env-feature.guard';
import { EnvVarsController } from './env-vars.controller';
import { EnvVarsRepository } from './env-vars.repository';
import { EnvVarsService } from './env-vars.service';
import { ProviderClientRegistry } from './infrastructure/providers/core/provider-client.registry';
import { ProjectDeploymentProvisioningService } from './project-deployment-provisioning.service';
import { RenderCiSecretsService } from './render-ci-secrets.service';
import { RenderCostPolicyService } from './render-cost-policy.service';
import { RenderEnvClient } from './infrastructure/providers/render/render-env.client';
import { VercelEnvClient } from './infrastructure/providers/vercel/vercel-env.client';
import { ProviderConnectionsController } from './provider-connections.controller';
import { ProviderConnectionsRepository } from './provider-connections.repository';
import { ProviderConnectionsService } from './provider-connections.service';
import { VercelCiSecretsService } from './vercel-ci-secrets.service';
import { LocalDeploymentHistoryProvider } from './application/local-deployment-history.provider';
import { ProjectDeploymentsService } from './application/project-deployments.service';
import { ProjectDriftService } from './application/project-drift.service';
import { ProjectSyncFindingsRepository } from './application/project-sync-findings.repository';

@Module({
  imports: [
    AuditModule,
    DatabaseModule,
    GithubModule,
    NotificationsModule,
    SubscriptionModule,
    UsageModule,
    WorkspacesModule,
    CiModule,
  ],
  controllers: [
    ProviderConnectionsController,
    DeploymentTargetsController,
    EnvVarsController,
  ],
  providers: [
    ProviderConnectionsRepository,
    DeploymentTargetsRepository,
    EnvVarsRepository,
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
    ProviderConnectionsRepository,
    EnvTokenEncryptionService,
    ProviderClientRegistry,
  ],
})
export class DeploymentsModule {}
