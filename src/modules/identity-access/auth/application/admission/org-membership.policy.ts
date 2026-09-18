import { Injectable, Logger } from '@nestjs/common';

import type { AuthAdmissionMode } from '#kernel/config/app.config.types.js';
import {
  resolveInternalMembershipGate,
  type OrgMembershipCheck,
} from '../oauth-callback.helpers.js';
import type {
  AdmissionPolicy,
  AdmissionPolicyResult,
  ResolvedProviderProfile,
} from './admission-policy.port.js';

export interface OrgMembershipAdmissionPolicyOptions {
  internalOrg: string;
  admission: AuthAdmissionMode;
}

/**
 * Membership-backed internal stamping with a configurable admission result.
 * The membership lookup always runs for a configured internal org so explicit
 * AUTH_ADMISSION=open can admit non-members while still stamping members.
 */
@Injectable()
export class OrgMembershipAdmissionPolicy implements AdmissionPolicy {
  // Keep the existing logger context so moving this check does not change
  // operational filters or alert routing for the default deployment behavior.
  private readonly logger = new Logger('AuthService');

  constructor(private readonly options: OrgMembershipAdmissionPolicyOptions) {}

  async evaluate(
    profile: ResolvedProviderProfile,
    providerAccessToken: string,
  ): Promise<AdmissionPolicyResult> {
    const membership =
      await this.checkInternalOrgMembership(providerAccessToken);
    const membershipGate = resolveInternalMembershipGate({
      internalOrg: this.options.internalOrg,
      membership,
      login: profile.login,
    });

    if (membershipGate.kind === 'unauthorized') {
      if (this.options.admission === 'org-membership') {
        return {
          kind: 'deny',
          login: membershipGate.login,
          reason: membershipGate.reason,
        };
      }

      // AUTH_ADMISSION=open changes only admission. A configured org was still
      // checked, so a confirmed non-member is authoritative false rather than
      // null (null remains the no-org, do-not-clobber value).
      return { kind: 'admit', isInternal: false };
    }

    return { kind: 'admit', isInternal: membershipGate.isInternal };
  }

  /**
   * Checks whether the OAuth-authenticated user is an active member of the
   * configured internal org using the user's own token. The multi-state result
   * keeps confirmed non-members, pending invitations, and unverifiable checks
   * distinct for the org-membership admission policy.
   */
  private async checkInternalOrgMembership(
    accessToken: string,
  ): Promise<OrgMembershipCheck> {
    const org = this.options.internalOrg;
    if (!org) {
      return 'not_member';
    }

    try {
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (response.status === 404) {
        this.logger.log(
          `Org membership check: "${org}" returned 404 (confirmed non-member or unaccepted invite).`,
        );
        return 'not_member';
      }

      if (!response.ok) {
        this.logger.warn(
          `Org membership check for "${org}" returned ${String(response.status)}; could not verify, denying access. ` +
            'Common causes: the OAuth token is missing the read:org scope, or the GitHub org has "OAuth App access restrictions" enabled and has not approved this app.',
        );
        return 'verification_failed';
      }

      const payload = (await response.json()) as { state?: string };
      if (payload.state === 'active') {
        return 'member';
      }
      // GET /user/memberships/orgs/{org} returns 200 with state 'pending' for
      // a user who was invited but has not accepted the invitation yet.
      if (payload.state === 'pending') {
        this.logger.log(
          `Org membership check: "${org}" invitation is pending acceptance.`,
        );
        return 'invitation_pending';
      }
      this.logger.log(
        `Org membership check: "${org}" returned state "${payload.state ?? 'unknown'}"; treating as non-member.`,
      );
      return 'not_member';
    } catch (err) {
      this.logger.warn(
        `Org membership check for "${org}" failed: ${err instanceof Error ? err.message : String(err)}; could not verify, denying access.`,
      );
      return 'verification_failed';
    }
  }
}
