import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../../config/app.config';
import { DatabaseModule } from '../../../database/database.module';
import { DeploymentsCoreModule } from '../../core/deployments-core.module';
import { DeploymentProviderRegistry } from '../../core/deployment-provider.registry';
import {
  GcpDeploymentProvider,
  type GcpDeploymentProviderConfig,
} from './gcp.provider';
import { FakeGcpRuntimeAdapter } from './fake-gcp-runtime.adapter';
import { GCP_RUNTIME_ADAPTER } from './gcp-runtime.port';
import { GoogleCloudRuntimeAdapter } from './infrastructure/google-cloud-runtime.adapter';
import { GcpDeploymentTargetsRepository } from './gcp-deployment-targets.repository';
import { GcpProvisioningExecutor } from './gcp-provisioning.executor';
import { GcpProvisioningService } from './gcp-provisioning.service';
import { ProvisioningJobsRepository } from './provisioning-jobs.repository';

@Module({
  imports: [DatabaseModule, DeploymentsCoreModule],
  providers: [
    GcpDeploymentTargetsRepository,
    ProvisioningJobsRepository,
    GcpProvisioningExecutor,
    {
      provide: GcpDeploymentProvider,
      inject: [ConfigService, DeploymentProviderRegistry],
      useFactory: (
        configService: ConfigService,
        registry: DeploymentProviderRegistry,
      ) => {
        const config = configService.getOrThrow<AppConfig>('app').gcpDeployments;
        const providerConfig: GcpDeploymentProviderConfig = {
          enabled: config.enabled,
          projectId: config.sharedProjectId,
          region: config.region,
          artifactRegistryRepository: config.artifactRegistryRepository,
        };

        return new GcpDeploymentProvider(providerConfig, registry);
      },
    },
    {
      provide: GCP_RUNTIME_ADAPTER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const config = configService.getOrThrow<AppConfig>('app').gcpDeployments;
        return config.enabled
          ? new GoogleCloudRuntimeAdapter()
          : new FakeGcpRuntimeAdapter();
      },
    },
    {
      provide: GcpProvisioningService,
      inject: [
        ConfigService,
        GcpDeploymentTargetsRepository,
        ProvisioningJobsRepository,
      ],
      useFactory: (
        configService: ConfigService,
        deploymentTargets: GcpDeploymentTargetsRepository,
        provisioningJobs: ProvisioningJobsRepository,
      ) => {
        const config = configService.getOrThrow<AppConfig>('app').gcpDeployments;
        return new GcpProvisioningService(
          {
            enabled: config.enabled,
            projectId: config.sharedProjectId,
            region: config.region,
            artifactRegistryRepository: config.artifactRegistryRepository,
          },
          deploymentTargets,
          provisioningJobs,
        );
      },
    },
  ],
  exports: [
    GcpDeploymentProvider,
    GCP_RUNTIME_ADAPTER,
    GcpProvisioningExecutor,
    GcpProvisioningService,
  ],
})
export class GcpDeploymentModule {}
