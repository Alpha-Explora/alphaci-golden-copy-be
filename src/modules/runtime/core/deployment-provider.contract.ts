export interface ProviderCapabilities {
  envVars: boolean;
  logs: boolean;
  deployHistory: boolean;
  teardown: boolean;
  managedMode: boolean;
  liveStatus: boolean;
  connectivity: 'direct' | 'indirect';
  enumerable: boolean;
  credentialCustody: 'platform' | 'external';
}

export interface ProviderFormField {
  key: string;
  label: string;
  required: boolean;
}

export interface ProviderFormSchema {
  fields: ProviderFormField[];
}

/** Provider ids supported by the current deployment runtime. */
export const DEPLOYMENT_PROVIDER_IDS = ['render', 'vercel'] as const;
export type DeploymentProviderId = (typeof DEPLOYMENT_PROVIDER_IDS)[number];

/** Legacy defaults retained for response compatibility until providers are user-selected. */
export const DEFAULT_BACKEND_PROVIDER_ID = DEPLOYMENT_PROVIDER_IDS[0];
export const DEFAULT_FRONTEND_PROVIDER_ID = DEPLOYMENT_PROVIDER_IDS[1];

/** Provider ids that currently expose the frontend preview lane. */
export const PREVIEW_DEPLOYMENT_PROVIDER_IDS = ['vercel'] as const;

export interface DeploymentProvider {
  readonly id: string;
  readonly label: string;
  readonly supportedSlots: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly configSchema: ProviderFormSchema;
  readonly credentialSchema: ProviderFormSchema;
  isEnabled(): { enabled: boolean; reason?: string };
  validateConfig(config: Record<string, unknown>): void;
}
