import type {
  DeploymentProviderPresentationTarget,
  ProviderCapabilities,
  ProviderFormSchema,
} from '../../../core/deployment-provider.contract';

export interface LegacyProviderConfig {
  label: string;
  enabled: boolean;
  supportedSlots: readonly string[];
  previewDeployments?: boolean;
}

export const LEGACY_PROVIDER_CONFIG_SCHEMA: ProviderFormSchema = {
  fields: [
    {
      key: 'providerProjectId',
      label: 'Provider project or service ID',
      required: true,
    },
  ],
};

export const LEGACY_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  envVars: true,
  logs: true,
  deployHistory: true,
  teardown: true,
  managedMode: true,
  liveStatus: true,
  connectivity: 'direct',
  enumerable: true,
  credentialCustody: 'platform',
  envProvisioning: true,
};

export function providerMetadataString(
  target: DeploymentProviderPresentationTarget,
  key: string,
): string {
  const value = target.providerMetadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
