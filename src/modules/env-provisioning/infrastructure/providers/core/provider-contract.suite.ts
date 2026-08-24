import type { DeploymentProvider } from './deployment-provider.contract';

/**
 * Shared structural assertions for provider adapters. The suite intentionally
 * avoids network calls; each adapter's existing provider-client specs retain
 * the payload/error behavior tests.
 */
export function assertDeploymentProviderContract(
  provider: DeploymentProvider,
): void {
  if (provider.provider !== 'render' && provider.provider !== 'vercel') {
    throw new Error(`Unsupported deployment provider: ${provider.provider}`);
  }

  const requiredOperations = [
    provider.validateConnection,
    provider.listTargets,
    provider.createTarget,
    provider.upsertEnvironmentVariables,
    provider.deleteEnvironmentVariable,
    provider.getTargetStatus,
    provider.deleteTarget,
  ];
  if (requiredOperations.some((operation) => typeof operation !== 'function')) {
    throw new Error(`Provider ${provider.provider} does not implement the deployment contract`);
  }
}
