import {
  resolveInternalMembershipGate,
  unauthorizedAuthRedirect,
  type UnauthorizedAuthReason,
} from './oauth-callback.helpers';

function withQuery(url: string, key: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

describe('unauthorizedAuthRedirect', () => {
  const returnTo = 'http://localhost:3000/auth/callback';
  const internalOrg = 'acme-internal';

  it.each([
    ['not_member', 'not_authorized'],
    ['invitation_pending', 'org_invite_pending'],
    ['verification_failed', 'org_verification_failed'],
  ] as const)('maps %s to auth=%s', (reason, authCode) => {
    const url = unauthorizedAuthRedirect({
      returnTo,
      reason,
      internalOrg,
      withQuery,
    });

    expect(url).toContain(`auth=${authCode}`);
  });

  it('appends org=<internalOrg> only for invitation_pending', () => {
    const pending = unauthorizedAuthRedirect({
      returnTo,
      reason: 'invitation_pending',
      internalOrg,
      withQuery,
    });
    expect(pending).toContain('auth=org_invite_pending');
    expect(pending).toContain(`org=${internalOrg}`);
    expect(pending).not.toContain('auth=not_authorized');

    const blockedReasons: UnauthorizedAuthReason[] = [
      'not_member',
      'verification_failed',
    ];
    for (const reason of blockedReasons) {
      const url = unauthorizedAuthRedirect({
        returnTo,
        reason,
        internalOrg,
        withQuery,
      });
      expect(url).not.toContain('org=');
    }
  });
});

describe('resolveInternalMembershipGate', () => {
  it('skips the gate on a sold deployment (unset org) and leaves isInternal null', () => {
    expect(
      resolveInternalMembershipGate({
        internalOrg: '',
        membership: 'not_member',
        login: 'octocat',
      }),
    ).toEqual({ kind: 'ok', isInternal: null });
    expect(
      resolveInternalMembershipGate({
        internalOrg: '',
        membership: 'member',
        login: 'octocat',
      }),
    ).toEqual({ kind: 'ok', isInternal: null });
  });

  it('admits an active org member as internal', () => {
    expect(
      resolveInternalMembershipGate({
        internalOrg: 'acme-internal',
        membership: 'member',
        login: 'octocat',
      }),
    ).toEqual({ kind: 'ok', isInternal: true });
  });

  it.each([
    'not_member',
    'invitation_pending',
    'verification_failed',
  ] as const)('fail-closes when membership is %s', (reason) => {
    expect(
      resolveInternalMembershipGate({
        internalOrg: 'acme-internal',
        membership: reason,
        login: 'octocat',
      }),
    ).toEqual({
      kind: 'unauthorized',
      login: 'octocat',
      reason,
    });
  });
});
