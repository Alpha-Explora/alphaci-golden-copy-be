/**
 * Provider discovery data exposed to contexts that render capabilities.
 * Runtime owns the adapter; consumers do not receive provider clients or
 * provider implementation methods.
 */
export interface DeploymentProviderCatalogEntry {
  id: string;
  enabled: boolean;
  envProvisioning: boolean;
  previewDeployments: boolean;
}

export interface DeploymentProviderCatalogPort {
  list(): readonly DeploymentProviderCatalogEntry[];
}

export const DEPLOYMENT_PROVIDER_CATALOG = Symbol(
  'DEPLOYMENT_PROVIDER_CATALOG',
);
