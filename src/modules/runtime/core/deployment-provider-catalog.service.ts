import { Injectable } from '@nestjs/common';

import type { DeploymentProvider } from './deployment-provider.contract';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import type {
  DeploymentProviderCatalogEntry,
  DeploymentProviderCatalogPort,
} from '#kernel/ports/deployment-provider-catalog.port';

/** Runtime adapter that exposes only capability data to other contexts. */
@Injectable()
export class DeploymentProviderCatalogService implements DeploymentProviderCatalogPort {
  constructor(
    private readonly providerRegistry: DeploymentProviderRegistry<DeploymentProvider>,
  ) {}

  list(): readonly DeploymentProviderCatalogEntry[] {
    return this.providerRegistry.list().map((provider) => ({
      id: provider.id,
      enabled: provider.isEnabled().enabled,
      envProvisioning: provider.capabilities.envProvisioning ?? true,
      previewDeployments: provider.capabilities.previewDeployments === true,
    }));
  }
}
