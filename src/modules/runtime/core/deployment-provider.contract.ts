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
  /** Whether this provider is available through the runtime env API. */
  envProvisioning?: boolean;
  /** Whether this provider exposes a branch-scoped preview lane. */
  previewDeployments?: boolean;
}

export interface ProviderFormField {
  key: string;
  label: string;
  required: boolean;
}

export interface ProviderFormSchema {
  fields: ProviderFormField[];
}

/**
 * Provider ids are open data, not a closed TypeScript union. A provider plugin
 * owns its id and registers it at runtime; adding one must not require editing
 * this contract or a central DTO union.
 */
export type DeploymentProviderId = string;

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
