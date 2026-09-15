import type { CapabilityKey, Edition } from './capability-types.js';

/**
 * A per-customer narrowing declaration applied after the edition manifest.
 *
 * A policy can only remove capabilities. That restriction is what keeps the
 * build profile an honest ceiling: if a client policy could enable a key, the
 * compiled artifact scan would no longer describe what a deployment can do.
 * A capability one client needs and another must not see belongs in the
 * edition manifest, with every other client's policy removing it.
 */
export interface ClientCapabilityPolicy {
  readonly clientId: string;
  readonly displayName: string;
  readonly edition: Edition;
  readonly disabledCapabilities: readonly CapabilityKey[];
}

export type ClientPolicyRegistry = Readonly<
  Record<string, ClientCapabilityPolicy>
>;
