/**
 * Product defaults, kept separate from the provider contract.
 *
 * These values preserve the existing FlowCI provisioning behaviour for legacy
 * projects. They are policy defaults only; provider plugins register their own
 * ids and capabilities through DeploymentProviderRegistry.
 */
export const DEFAULT_BACKEND_PROVIDER_ID = 'render';
export const DEFAULT_FRONTEND_PROVIDER_ID = 'vercel';
