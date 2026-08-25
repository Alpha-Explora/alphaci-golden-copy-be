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
