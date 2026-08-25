import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../../../config/app.config';
import { DeploymentsCoreModule } from '../../../core/deployments-core.module';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { LegacyDeploymentProvider } from './legacy-deployment.provider';

@Module({
  imports: [DeploymentsCoreModule],
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
