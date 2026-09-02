/**
 * Pure OAuth-callback helpers. Kept out of AuthService so the callback is a
 * linear switch on AccountState.kind and the internal-org gate stays
 * fail-closed in one place.
 */

export type UnauthorizedAuthReason =
  | 'not_member'
  | 'invitation_pending'
  | 'verification_failed';

/** Result of checking GitHub org membership for the internal gate. */
export type OrgMembershipCheck = 'member' | UnauthorizedAuthReason;

export type InternalMembershipGateResult =
  | {
      kind: 'unauthorized';
      login: string;
      reason: UnauthorizedAuthReason;
    }
  | { kind: 'ok'; isInternal: true | null };

const AUTH_CODE_BY_REASON = {
  not_member: 'not_authorized',
  invitation_pending: 'org_invite_pending',
  verification_failed: 'org_verification_failed',
} as const;

type QueryAppender = (url: string, key: string, value: string) => string;

/**
 * Maps an unauthorized AccountState reason to the FE redirect codes used today:
 * not_member → not_authorized, invitation_pending → org_invite_pending,
 * verification_failed → org_verification_failed. Pending invitations also
 * append org=<internalOrg> so the FE can link to GitHub's accept page.
 */
export function unauthorizedAuthRedirect(args: {
  returnTo: string;
  reason: UnauthorizedAuthReason;
  internalOrg: string;
  withQuery: QueryAppender;
}): string {
  let redirect = args.withQuery(
    args.returnTo,
    'auth',
    AUTH_CODE_BY_REASON[args.reason],
  );
  if (args.reason === 'invitation_pending') {
    redirect = args.withQuery(redirect, 'org', args.internalOrg);
  }
  return redirect;
}

/**
 * Internal-deployment membership gate. Fail-closed: when GITHUB_INTERNAL_ORG
 * is set, anything other than 'member' is unauthorized. Sold deployments
 * (unset org) skip the gate and leave isInternal null so existing flags are
 * not clobbered.
 */
export function resolveInternalMembershipGate(args: {
  internalOrg: string;
  membership: OrgMembershipCheck;
  login: string;
}): InternalMembershipGateResult {
  if (!args.internalOrg) {
    return { kind: 'ok', isInternal: null };
  }

  if (args.membership !== 'member') {
    return {
      kind: 'unauthorized',
      login: args.login,
      reason: args.membership,
    };
  }

  return { kind: 'ok', isInternal: true };
}
