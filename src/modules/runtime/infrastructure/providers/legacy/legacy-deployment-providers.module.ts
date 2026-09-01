import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { RuntimeCoreModule } from '../../../core/runtime-core.module';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { WORKFLOW_FRAGMENTS } from '../../../core/workflow-fragment.contract';
import { PROVIDER_CLIENTS } from '../core/provider-client.registry';
import { RenderEnvClient } from '../render/render-env.client';
import { renderWorkflowFragment } from '../render/render-workflow.fragment';
import {
  RENDER_DEPLOYMENT_PROVIDER,
  RenderDeploymentProvider,
} from '../render/render-deployment.provider';
import { RenderCostPolicyService } from '../render/render-cost-policy.service';
import { RenderDeploymentPolicy } from '../render/render-deployment.policy';
import { VercelEnvClient } from '../vercel/vercel-env.client';
import { vercelWorkflowFragment } from '../vercel/vercel-workflow.fragment';
import {
  VERCEL_DEPLOYMENT_PROVIDER,
  VercelDeploymentProvider,
} from '../vercel/vercel-deployment.provider';
import { VercelDeploymentPolicy } from '../vercel/vercel-deployment.policy';

@Module({
  imports: [RuntimeCoreModule],
  providers: [
    RenderCostPolicyService,
    RenderDeploymentPolicy,
    VercelDeploymentPolicy,
    RenderEnvClient,
    VercelEnvClient,
    {
      provide: PROVIDER_CLIENTS,
      useFactory: (
        renderClient: RenderEnvClient,
        vercelClient: VercelEnvClient,
      ) => [renderClient, vercelClient],
      inject: [RenderEnvClient, VercelEnvClient],
    },
    {
      provide: WORKFLOW_FRAGMENTS,
      useValue: [renderWorkflowFragment, vercelWorkflowFragment],
    },
    {
      provide: RENDER_DEPLOYMENT_PROVIDER,
      inject: [
        ConfigService,
        DeploymentProviderRegistry,
        RenderDeploymentPolicy,
      ],
      useFactory: (
        configService: ConfigService,
        registry: DeploymentProviderRegistry,
        policy: RenderDeploymentPolicy,
      ) => {
        const config = configService.getOrThrow<AppConfig>('app');
        return new RenderDeploymentProvider(
          {
            label: 'Render',
            enabled: config.envProvisioning.enabled,
            // Preserve the established target policy: Render is the backend
            // provider. The old metadata advertised `standalone`, but the
            // domain policy rejected it; exposing only the actually supported
            // slot keeps discovery and validation truthful.
            supportedSlots: ['backend'],
            previewDeployments: false,
          },
          registry,
          policy,
        );
      },
    },
    {
      provide: VERCEL_DEPLOYMENT_PROVIDER,
      inject: [
        ConfigService,
        DeploymentProviderRegistry,
        VercelDeploymentPolicy,
      ],
      useFactory: (
        configService: ConfigService,
        registry: DeploymentProviderRegistry,
        policy: VercelDeploymentPolicy,
      ) => {
        const config = configService.getOrThrow<AppConfig>('app');
        return new VercelDeploymentProvider(
          {
            label: 'Vercel',
            enabled: config.envProvisioning.enabled,
            supportedSlots: ['frontend'],
            previewDeployments: true,
          },
          registry,
          policy,
        );
      },
    },
  ],
  exports: [
    PROVIDER_CLIENTS,
    WORKFLOW_FRAGMENTS,
    RENDER_DEPLOYMENT_PROVIDER,
    VERCEL_DEPLOYMENT_PROVIDER,
    RenderEnvClient,
    VercelEnvClient,
    RenderCostPolicyService,
    RenderDeploymentPolicy,
    VercelDeploymentPolicy,
  ],
})
export class LegacyDeploymentProvidersModule {}
