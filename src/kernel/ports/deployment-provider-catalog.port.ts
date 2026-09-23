/**
 * Provider discovery data exposed to contexts that render capabilities.
 * Runtime owns the adapter; consumers do not receive provider clients or
 * provider implementation methods.
 */
export interface DeploymentProviderCatalogEntry {
  id: string;
  /** Host-neutral display name; consumers must never hard-code a vendor label. */
  label: string;
  enabled: boolean;
  envProvisioning: boolean;
  previewDeployments: boolean;
  /** Whether this provider exposes runtime log retrieval. */
  logs: boolean;
}

export interface DeploymentProviderCatalogPort {
  list(): readonly DeploymentProviderCatalogEntry[];
}

export const DEPLOYMENT_PROVIDER_CATALOG = Symbol(
  'DEPLOYMENT_PROVIDER_CATALOG',
);
