import type { DeploymentProvider } from '../../../core/deployment-provider.contract';
import type { RuntimeProviderPack } from '../../../core/provider-pack';

export interface GcpProviderPackInput {
  provider: DeploymentProvider;
}

/** Assemble GCP's current catalog/provisioning-only Runtime contribution. */
export function createGcpProviderPack(
  input: GcpProviderPackInput,
): RuntimeProviderPack {
  return {
    id: input.provider.id,
    provider: input.provider,
  };
}
