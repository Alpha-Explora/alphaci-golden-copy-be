import { BadGatewayException } from '@nestjs/common';

import { GithubTeamAccessLiveProvider } from './github-team-access.live';

type Route = (url: string, init?: RequestInit) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const notFound = () => new Response('{}', { status: 404 });

/** Installs a fetch double driven by an ordered list of route matchers. */
function mockFetch(...routes: Route[]) {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.get('Authorization'),
    });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return Promise.resolve(response);
    }
    return Promise.reject(new Error(`unmocked fetch ${url}`));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

const REPO = 'Alphaexplora-Sandbox/payments-api';
const TEAM = 'payments-api-developers';

function setup() {
  const githubService = {
    getOrganizationProvisioningContextByLogin: jest
      .fn()
      .mockResolvedValue({ accessToken: 'org-token', ownerLogin: 'org' }),
    getInstallationAccessTokenForUserRepo: jest.fn().mockResolvedValue(null),
  };
  const provider = new GithubTeamAccessLiveProvider(githubService as never);
  return { provider, githubService };
}

const verifyInput = (intent?: 'grant' | 'revoke') => ({
  repoFullName: REPO,
  githubLogin: 'dev-one',
  expectedPermission: 'write' as const,
  expectedTeamSlug: TEAM,
  actingUserId: 'lead-1',
  ...(intent && { intent }),
});

describe('GithubTeamAccessLiveProvider credential', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  /*
   * Production has zero per-user installation rows, so the old
   * getInstallationAccessTokenForUserRepo lookup returned null and every grant
   * failed with "No GitHub App installation token available".
   */
  it('uses the organization installation token, never the acting user installation', async () => {
    const { provider, githubService } = setup();
    const { calls } = mockFetch(
      (url) =>
        url.endsWith('/orgs/Alphaexplora-Sandbox/teams')
          ? json({ id: 7, slug: TEAM })
          : undefined,
      (url) =>
        url.includes('/repos/')
          ? new Response(null, { status: 204 })
          : undefined,
    );

    await provider.ensureTeam({
      repositoryId: 'r1',
      repoFullName: REPO,
      actingUserId: 'lead-with-no-installation',
    });

    expect(
      githubService.getOrganizationProvisioningContextByLogin,
    ).toHaveBeenCalledWith('Alphaexplora-Sandbox');
    expect(
      githubService.getInstallationAccessTokenForUserRepo,
    ).not.toHaveBeenCalled();
    expect(calls.every((call) => call.auth === 'Bearer org-token')).toBe(true);
  });

  it('mints the token once for the several calls of one job', async () => {
    const { provider, githubService } = setup();
    mockFetch(
      () => json({ id: 7, slug: TEAM }),
      () => new Response(null, { status: 204 }),
    );
    await provider.ensureTeam({
      repositoryId: 'r1',
      repoFullName: REPO,
      actingUserId: 'u',
    });
    await provider.addMember({
      orgLogin: 'Alphaexplora-Sandbox',
      githubTeamSlug: TEAM,
      githubLogin: 'dev-one',
      repoFullName: REPO,
      actingUserId: 'u',
    });
    expect(
      githubService.getOrganizationProvisioningContextByLogin,
    ).toHaveBeenCalledTimes(1);
  });

  it('fails with a clear 502 when the App has no installation on the org', async () => {
    const { provider, githubService } = setup();
    githubService.getOrganizationProvisioningContextByLogin.mockRejectedValue(
      new Error('App is not installed on Alphaexplora-Sandbox'),
    );
    mockFetch(() => json({}));
    await expect(
      provider.addMember({
        orgLogin: 'Alphaexplora-Sandbox',
        githubTeamSlug: TEAM,
        githubLogin: 'dev-one',
        repoFullName: REPO,
        actingUserId: 'u',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('App is not installed'),
      }),
    });
  });
});

describe('GithubTeamAccessLiveProvider grant verification', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const permission = (role: string) => (url: string) =>
    url.includes('/collaborators/dev-one/permission')
      ? json({
          permission: role === 'maintain' ? 'write' : role,
          role_name: role,
        })
      : undefined;
  const noDirect = (url: string) =>
    url.includes('/collaborators?affiliation=direct') ? json([]) : undefined;
  const onlyOwnTeam = (url: string) =>
    url.endsWith('/teams?per_page=100') ? json([{ slug: TEAM }]) : undefined;

  it('accepts exactly Write with no unapproved grant', async () => {
    const { provider } = setup();
    mockFetch(permission('write'), noDirect, onlyOwnTeam);
    await expect(
      provider.verifyEffectivePermission(verifyInput()),
    ).resolves.toEqual({
      hasAccess: true,
      permission: 'write',
      hasUnapprovedGrant: false,
    });
  });

  it.each(['admin', 'maintain'])(
    'accepts %s (already above write: org owner / repository creator) without failing the grant',
    async (role) => {
      const { provider } = setup();
      // A creator is also a direct collaborator; that must not flag them.
      mockFetch(permission(role), (url) =>
        url.includes('/collaborators?affiliation=direct')
          ? json([{ login: 'dev-one' }])
          : undefined,
      );
      await expect(
        provider.verifyEffectivePermission(verifyInput()),
      ).resolves.toMatchObject({ hasAccess: true, hasUnapprovedGrant: false });
    },
  );

  it('does not verify when the org base read is all the person has', async () => {
    const { provider } = setup();
    mockFetch(permission('read'));
    await expect(
      provider.verifyEffectivePermission(verifyInput()),
    ).resolves.toMatchObject({ hasAccess: false, permission: 'read' });
  });

  it('flags a direct collaborator at Write as an unapproved grant', async () => {
    const { provider } = setup();
    mockFetch(permission('write'), (url) =>
      url.includes('/collaborators?affiliation=direct')
        ? json([{ login: 'Dev-One' }])
        : undefined,
    );
    await expect(
      provider.verifyEffectivePermission(verifyInput()),
    ).resolves.toMatchObject({ hasAccess: true, hasUnapprovedGrant: true });
  });

  it('treats a 404 permission as no access', async () => {
    const { provider } = setup();
    mockFetch((url) => (url.includes('/permission') ? notFound() : undefined));
    await expect(
      provider.verifyEffectivePermission(verifyInput()),
    ).resolves.toMatchObject({ hasAccess: false });
  });

  it('throws on an unexpected GitHub failure rather than guessing', async () => {
    const { provider } = setup();
    mockFetch((url) =>
      url.includes('/permission') ? json({ message: 'boom' }, 500) : undefined,
    );
    await expect(
      provider.verifyEffectivePermission(verifyInput()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('GithubTeamAccessLiveProvider revoke verification (org base permission is read)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const permission = (role: string) => (url: string) =>
    url.includes('/collaborators/dev-one/permission')
      ? json({ permission: role, role_name: role })
      : undefined;
  const memberOfTeam = (isMember: boolean) => (url: string) =>
    url.includes(`/teams/${TEAM}/memberships/dev-one`)
      ? isMember
        ? json({ state: 'active' })
        : notFound()
      : undefined;
  const noDirect = (url: string) =>
    url.includes('/collaborators?affiliation=direct') ? json([]) : undefined;
  const onlyOwnTeam = (url: string) =>
    url.endsWith('/teams?per_page=100') ? json([{ slug: TEAM }]) : undefined;

  /*
   * The old check was `permission !== 'none'`, which can never pass: the org
   * base permission is read, so a fully revoked person still reports 'read'.
   */
  it('is verified when the person is out of the team and only holds the base read', async () => {
    const { provider } = setup();
    mockFetch(permission('read'), memberOfTeam(false), noDirect, onlyOwnTeam);
    await expect(
      provider.verifyEffectivePermission(verifyInput('revoke')),
    ).resolves.toMatchObject({ hasAccess: false, permission: 'read' });
  });

  it('is NOT verified while the person is still in the repository team', async () => {
    const { provider } = setup();
    mockFetch(permission('write'), memberOfTeam(true), noDirect, onlyOwnTeam);
    await expect(
      provider.verifyEffectivePermission(verifyInput('revoke')),
    ).resolves.toMatchObject({ hasAccess: true });
  });

  it('is NOT verified while the person is still a direct collaborator', async () => {
    const { provider } = setup();
    mockFetch(permission('write'), memberOfTeam(false), (url) =>
      url.includes('/collaborators?affiliation=direct')
        ? json([{ login: 'dev-one' }])
        : undefined,
    );
    await expect(
      provider.verifyEffectivePermission(verifyInput('revoke')),
    ).resolves.toMatchObject({ hasAccess: true });
  });

  it('is NOT verified when another team still gives Write', async () => {
    const { provider } = setup();
    mockFetch(
      permission('write'),
      memberOfTeam(false),
      noDirect,
      (url) =>
        url.endsWith('/teams?per_page=100')
          ? json([{ slug: TEAM }, { slug: 'platform-all' }])
          : undefined,
      (url) =>
        url.includes('/teams/platform-all/memberships/dev-one')
          ? json({ state: 'active' })
          : undefined,
    );
    await expect(
      provider.verifyEffectivePermission(verifyInput('revoke')),
    ).resolves.toMatchObject({ hasAccess: true });
  });

  it('does not fail the revoke for an org owner whose admin comes from ownership', async () => {
    const { provider } = setup();
    mockFetch(permission('admin'), memberOfTeam(false), noDirect, onlyOwnTeam);
    await expect(
      provider.verifyEffectivePermission(verifyInput('revoke')),
    ).resolves.toMatchObject({ hasAccess: false, permission: 'admin' });
  });
});
