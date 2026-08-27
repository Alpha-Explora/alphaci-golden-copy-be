import { Module } from '@nestjs/common';

import { DeploymentProvidersController } from './deployment-providers.controller';
import { DeploymentProviderCatalogService } from './deployment-provider-catalog.service';
import { DeploymentProviderRegistry } from './deployment-provider.registry';
import { DEPLOYMENT_PROVIDER_CATALOG } from '#kernel/ports/deployment-provider-catalog.port';

@Module({
  controllers: [DeploymentProvidersController],
  providers: [
    DeploymentProviderRegistry,
    DeploymentProviderCatalogService,
    {
      provide: DEPLOYMENT_PROVIDER_CATALOG,
      useExisting: DeploymentProviderCatalogService,
    },
  ],
  exports: [DeploymentProviderRegistry, DEPLOYMENT_PROVIDER_CATALOG],
})
export class RuntimeCoreModule {}
