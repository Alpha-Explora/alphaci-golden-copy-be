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
      label: provider.label,
      enabled: provider.isEnabled().enabled,
      envProvisioning: provider.capabilities.envProvisioning ?? true,
      previewDeployments: provider.capabilities.previewDeployments === true,
      // Static per-provider declaration, not a per-request client probe: both
      // Render and Vercel only ever declare it once their runtime client
      // implements getLogs (see LEGACY_PROVIDER_CAPABILITIES / the GCP
      // descriptor's comment on keeping this catalog honest), so this stays
      // true to "the client actually implements logs" without this
      // deliberately dependency-light module reaching into the pack registry
      // that assembles the live client instances.
      logs: provider.capabilities.logs === true,
    }));
  }
}
