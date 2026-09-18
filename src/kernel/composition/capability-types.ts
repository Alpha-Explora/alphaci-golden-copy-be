import type { CAPABILITIES } from './capability-registry.js';
import type { CapabilityRecord } from './capability-record.types.js';

export type Edition = 'saas' | 'edu' | 'enterprise';
/** A build profile is a physical artifact ceiling, not an edition alias. */
export type BuildProfile = 'hosted-saas' | 'hosted-edu' | 'enterprise';
export type CapabilityKey = (typeof CAPABILITIES)[number]['key'];
export type {
  CapabilityMaturity,
  CapabilityRecord,
} from './capability-record.types.js';

export interface CapabilityManifest {
  readonly edition: Edition;
  readonly capabilities: readonly CapabilityKey[];
}

export type CapabilitySet = ReadonlySet<CapabilityKey>;

export interface CapabilityRuntimeConfig {
  readonly composition: {
    readonly edition: Edition;
    readonly profile: BuildProfile;
  };
}

export interface ResolveCapabilitiesInput {
  readonly registry?: readonly CapabilityRecord[];
  readonly manifest: CapabilityManifest;
  readonly config: CapabilityRuntimeConfig;
}
