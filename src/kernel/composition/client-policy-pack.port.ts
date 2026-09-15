import type { AppConfig } from '#kernel/config/app.config.js';
import type { BuildProfile, Edition } from './capability-types.js';
import type { ClientPolicySource } from './client-policy.port.js';

/** Public contract implemented by a build-profile-owned client policy pack. */
export interface ClientPolicyPack {
  /** Edition whose policy documents and declared registry this pack owns. */
  readonly edition: Edition;
  /** Create the source that selects and validates this deployment's policy. */
  createSource(composition: AppConfig['composition']): ClientPolicySource;
}

export const CLIENT_POLICY_PACK_LOADER = Symbol('ClientPolicyPackLoader');

export type ClientPolicyPackLoader = (
  profile: BuildProfile,
) => Promise<ClientPolicyPack | null>;
