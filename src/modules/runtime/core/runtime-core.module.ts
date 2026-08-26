import { Module } from '@nestjs/common';

import { DeploymentProvidersController } from './deployment-providers.controller';
import { DeploymentProviderRegistry } from './deployment-provider.registry';

@Module({
  controllers: [DeploymentProvidersController],
  providers: [DeploymentProviderRegistry],
  exports: [DeploymentProviderRegistry],
})
export class RuntimeCoreModule {}
