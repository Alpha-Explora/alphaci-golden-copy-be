import type { CompositionSubject } from '#kernel/composition/capability-resolver.port.js';
import type { ClientPolicySource } from '#kernel/composition/client-policy.port.js';
import type { ClientCapabilityPolicy } from '#kernel/composition/client-policy.types.js';

/** A deployment with no client selected. The edition manifest stays whole. */
export class NullClientPolicySource implements ClientPolicySource {
  deployment(): ClientCapabilityPolicy | null {
    return null;
  }

  for(subject: CompositionSubject): ClientCapabilityPolicy | null {
    void subject;
    return null;
  }
}

/**
 * A deployment dedicated to one client.
 *
 * The subject argument is accepted and ignored on purpose: a hosted source
 * that varies the policy per tenant can replace this class without touching
 * the resolver, guard, or controller.
 */
export class SingleClientPolicySource implements ClientPolicySource {
  constructor(private readonly policy: ClientCapabilityPolicy) {}

  deployment(): ClientCapabilityPolicy {
    return this.policy;
  }

  for(subject: CompositionSubject): ClientCapabilityPolicy {
    void subject;
    return this.policy;
  }
}
