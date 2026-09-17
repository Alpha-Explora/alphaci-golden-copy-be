import type { CapabilitySet } from './capability-types.js';

export const CAPABILITY_RESOLVER = Symbol('CapabilityResolver');
export const DEPLOYMENT_CAPABILITY_RESOLVER = Symbol(
  'DeploymentCapabilityResolver',
);

export interface CompositionSubject {
  readonly tenantId?: string;
}

export interface CapabilityResolverPort {
  /** Subject-scoped. Hosted resolution may narrow by tenant. */
  for(subject: CompositionSubject): CapabilitySet;
  /** Deployment composition for anonymous callers and boot checks. */
  deployment(): CapabilitySet;
}
