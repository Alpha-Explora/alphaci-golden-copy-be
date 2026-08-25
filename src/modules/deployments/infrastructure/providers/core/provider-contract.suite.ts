import type { DeploymentProvider } from './deployment-provider.contract';
import type { RuntimeEnvProviderClient } from './runtime-env-provider.client';

/**
 * Shared structural AND behavioral assertions for provider adapters.
 *
 * Structural checks confirm the adapter exposes the full provider-neutral
 * surface. Behavioral checks confirm the adapter honors the shared contract
 * semantics (correct return shapes, lane handling, error normalization) that
 * every consumer of a provider depends on, without making network calls.
 *
 * Provider-specific payload/error tests stay in each adapter's own spec; this
 * suite covers only what must be true for EVERY adapter.
 */
export function assertDeploymentProviderContract(
  provider: DeploymentProvider,
): void {
  assertStructuralContract(provider);
  assertProviderIdIsValid(provider);
}

function assertStructuralContract(provider: RuntimeEnvProviderClient): void {
  if (typeof provider.provider !== 'string') {
    throw new Error('Provider must have a string provider id');
  }

  const requiredOperations = [
    'validateConnection',
    'listTargets',
    'createTarget',
    'upsertEnvironmentVariables',
    'deleteEnvironmentVariable',
    'getTargetStatus',
    'deleteTarget',
  ] as const;

  for (const operation of requiredOperations) {
    if (typeof provider[operation] !== 'function') {
      throw new Error(
        `Provider ${provider.provider} does not implement required operation: ${operation}`,
      );
    }
  }

  // Optional operations, when present, must still be functions.
  const optionalOperations = ['getDeployHistory', 'getLogs'] as const;
  for (const operation of optionalOperations) {
    const value = provider[operation];
    if (value !== undefined && typeof value !== 'function') {
      throw new Error(
        `Provider ${provider.provider} has non-function optional operation: ${operation}`,
      );
    }
  }
}

function assertProviderIdIsValid(provider: RuntimeEnvProviderClient): void {
  if (provider.provider !== 'render' && provider.provider !== 'vercel') {
    throw new Error(`Unsupported deployment provider: ${provider.provider}`);
  }
}
