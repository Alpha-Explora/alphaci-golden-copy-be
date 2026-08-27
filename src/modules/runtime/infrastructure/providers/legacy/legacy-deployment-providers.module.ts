import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { RuntimeCoreModule } from '../../../core/runtime-core.module';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import {
  PROVIDER_CLIENTS,
  ProviderClientRegistry,
} from '../core/provider-client.registry';
import { RenderEnvClient } from '../render/render-env.client';
import { VercelEnvClient } from '../vercel/vercel-env.client';
import { LegacyDeploymentProvider } from './legacy-deployment.provider';

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
      provide: 'renderDeploymentProvider',
      inject: [ConfigService, DeploymentProviderRegistry],
      useFactory: (
        configService: ConfigService,
        registry: DeploymentProviderRegistry,
      ) => {
        const config = configService.getOrThrow<AppConfig>('app');
        return new LegacyDeploymentProvider(
          {
            id: 'render',
            label: 'Render',
            enabled: config.envProvisioning.enabled,
            supportedSlots: ['backend', 'standalone'],
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
        return new LegacyDeploymentProvider(
          {
            id: 'vercel',
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
  exports: [PROVIDER_CLIENTS],
})
export class LegacyDeploymentProvidersModule {}
