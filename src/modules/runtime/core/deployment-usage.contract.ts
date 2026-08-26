/**
 * Runtime-owned facts used by billing to account for managed deployment
 * capacity. The billing context consumes the dimensions as data and does not
 * need to know provider-specific identifiers or configuration field names.
 */
export interface DeploymentUsageFact {
  readonly providerId: string;
  readonly quotaCode: 'managed_render_services' | 'managed_vercel_projects';
  readonly fleetCapConfigKey: 'renderManagedFleetMax' | 'vercelManagedFleetMax';
  readonly providerLabel: string;
}

export type DeploymentUsageProviderId = DeploymentUsageFact['providerId'];

export const DEPLOYMENT_USAGE_FACTS: readonly DeploymentUsageFact[] = [
  {
    providerId: 'render',
    quotaCode: 'managed_render_services',
    fleetCapConfigKey: 'renderManagedFleetMax',
    providerLabel: 'Render',
  },
  {
    providerId: 'vercel',
    quotaCode: 'managed_vercel_projects',
    fleetCapConfigKey: 'vercelManagedFleetMax',
    providerLabel: 'Vercel',
  },
];
