import type { EnvProvider } from '../deployments.types';
import type { RuntimeEnvProviderClient } from '../infrastructure/providers/core/runtime-env-provider.client';

/**
 * Provider-neutral contract implemented by every deployment provider adapter.
 * Render and Vercel may translate these operations into different HTTP
 * payloads, but no caller needs to branch on vendor SDK details.
 */
export interface DeploymentProvider extends RuntimeEnvProviderClient {
  readonly provider: EnvProvider;
}

export const DEPLOYMENT_PROVIDER_OPERATIONS = [
  'validateConnection',
  'listTargets',
  'createTarget',
  'upsertEnvironmentVariables',
  'deleteEnvironmentVariable',
  'getTargetStatus',
  'deleteTarget',
] as const;
