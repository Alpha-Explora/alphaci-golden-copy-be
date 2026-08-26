import type { EnvProvider } from '../../core/deployments.types';
import type { RuntimeEnvProviderClient } from './runtime-env-provider.client';

/**
 * Application-facing provider lookup. The registry implementation and vendor
 * clients remain infrastructure concerns; application services only request a
 * provider-neutral client for the operation they already own.
 */
export interface ProviderClientRegistryPort {
  getClient(provider: EnvProvider): RuntimeEnvProviderClient;
}

export const PROVIDER_CLIENT_REGISTRY = Symbol('ProviderClientRegistry');
