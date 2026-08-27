import { Inject, Injectable, Optional } from '@nestjs/common';

import { type ProviderClientRegistryPort } from '../../../application/ports/provider-client-registry.port';
import type { RuntimeEnvProviderClient } from '../../../application/ports/runtime-env-provider.client';
import type { EnvProvider } from '../../../core/deployments.types';

/** DI seam for provider plugins. Runtime composition supplies the adapters. */
export const PROVIDER_CLIENTS = Symbol('ProviderClients');

@Injectable()
export class ProviderClientRegistry implements ProviderClientRegistryPort {
  private readonly clientsByProvider = new Map<
    EnvProvider,
    RuntimeEnvProviderClient
  >();

  constructor(
    @Optional()
    @Inject(PROVIDER_CLIENTS)
    clients: readonly RuntimeEnvProviderClient[] = [],
  ) {
    clients.forEach((client) => this.register(client));
  }

  register(client: RuntimeEnvProviderClient): void {
    if (this.clientsByProvider.has(client.provider)) {
      throw new Error(
        `Duplicate provider client for provider: ${client.provider}`,
      );
    }
    this.clientsByProvider.set(client.provider, client);
  }

  getClient(provider: EnvProvider): RuntimeEnvProviderClient {
    const client = this.clientsByProvider.get(provider);
    if (!client) {
      throw new Error(`No provider client registered for: ${provider}`);
    }
    return client;
  }
}
