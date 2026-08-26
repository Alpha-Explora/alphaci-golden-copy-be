import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { RuntimeCoreModule } from '../../../core/runtime-core.module';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { LegacyDeploymentProvider } from './legacy-deployment.provider';

@Module({
  imports: [RuntimeCoreModule],
  providers: [
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
          },
          registry,
        );
      },
    },
  ],
})
export class LegacyDeploymentProvidersModule {}
