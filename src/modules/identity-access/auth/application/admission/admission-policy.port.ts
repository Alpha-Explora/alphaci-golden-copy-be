import type { UnauthorizedAuthReason } from '../oauth-callback.helpers.js';

/** Provider profile after OAuth has resolved the user's stable identity. */
export interface ResolvedProviderProfile {
  githubUserId: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
}

/** Outcome of the sign-in admission and internal-stamping decision. */
export type AdmissionPolicyResult =
  | { kind: 'admit'; isInternal: boolean | null }
  | {
      kind: 'deny';
      reason: UnauthorizedAuthReason;
      login: string;
    };

/**
 * Application seam for deciding whether a resolved provider identity may sign
 * in. Implementations may also return the authoritative internal stamp that
 * the account workflow must persist for this provider profile.
 */
export interface AdmissionPolicy {
  evaluate(
    profile: ResolvedProviderProfile,
    providerAccessToken: string,
  ): Promise<AdmissionPolicyResult>;
}

export const ADMISSION_POLICY = Symbol('AdmissionPolicy');
