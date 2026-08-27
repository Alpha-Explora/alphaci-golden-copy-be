import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { RuntimeCoreModule } from '../../../core/runtime-core.module';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { WORKFLOW_FRAGMENTS } from '../../../core/workflow-fragment.contract';
import { PROVIDER_CLIENTS } from '../core/provider-client.registry';
import { RenderEnvClient } from '../render/render-env.client';
import { renderWorkflowFragment } from '../render/render-workflow.fragment';
import { RenderDeploymentProvider } from '../render/render-deployment.provider';
import { VercelEnvClient } from '../vercel/vercel-env.client';
import { vercelWorkflowFragment } from '../vercel/vercel-workflow.fragment';
import { VercelDeploymentProvider } from '../vercel/vercel-deployment.provider';

@Module({
  imports: [RuntimeCoreModule],
  providers: [
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
      provide: 'renderDeploymentProvider',
      inject: [ConfigService, DeploymentProviderRegistry],
      useFactory: (
        configService: ConfigService,
        registry: DeploymentProviderRegistry,
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
        );
      },
    },
    {
      provide: 'vercelDeploymentProvider',
      inject: [ConfigService, DeploymentProviderRegistry],
      useFactory: (
        configService: ConfigService,
        registry: DeploymentProviderRegistry,
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
        );
      },
    },
  ],
  exports: [PROVIDER_CLIENTS, WORKFLOW_FRAGMENTS],
})
export class LegacyDeploymentProvidersModule {}
