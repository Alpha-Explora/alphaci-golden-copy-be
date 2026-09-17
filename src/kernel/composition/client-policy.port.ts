import type { CompositionSubject } from './capability-resolver.port.js';
import type { ClientCapabilityPolicy } from './client-policy.types.js';

export const CLIENT_POLICY_SOURCE = Symbol('ClientPolicySource');

export interface ClientPolicySource {
  /** Policy for the deployment itself, used for boot checks and anonymous callers. */
  deployment(): ClientCapabilityPolicy | null;
  /** Policy for one subject. A hosted source may later vary this per tenant. */
  for(subject: CompositionSubject): ClientCapabilityPolicy | null;
}
