import { OrgMembershipAdmissionPolicy } from './org-membership.policy.js';

describe('OrgMembershipAdmissionPolicy', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(jest.fn());
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('admits an active member and stamps them internal', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ state: 'active' }),
    });
    const policy = new OrgMembershipAdmissionPolicy({
      internalOrg: 'acme-internal',
      admission: 'org-membership',
    });

    await expect(
      policy.evaluate(
        { githubUserId: '12345', login: 'octocat' },
        'provider-token',
      ),
    ).resolves.toEqual({ kind: 'admit', isInternal: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/memberships/orgs/acme-internal',
      {
        headers: {
          Authorization: 'Bearer provider-token',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );
  });

  it('denies a confirmed non-member in org-membership mode', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    const policy = new OrgMembershipAdmissionPolicy({
      internalOrg: 'acme-internal',
      admission: 'org-membership',
    });

    await expect(
      policy.evaluate(
        { githubUserId: '12345', login: 'octocat' },
        'provider-token',
      ),
    ).resolves.toEqual({
      kind: 'deny',
      login: 'octocat',
      reason: 'not_member',
    });
  });

  it('admits a confirmed non-member with false stamping in open mode', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    const policy = new OrgMembershipAdmissionPolicy({
      internalOrg: 'acme-internal',
      admission: 'open',
    });

    await expect(
      policy.evaluate(
        { githubUserId: '12345', login: 'octocat' },
        'provider-token',
      ),
    ).resolves.toEqual({ kind: 'admit', isInternal: false });
  });

  it('leaves the stamp null when no internal org is configured', async () => {
    const policy = new OrgMembershipAdmissionPolicy({
      internalOrg: '',
      admission: 'org-membership',
    });

    await expect(
      policy.evaluate(
        { githubUserId: '12345', login: 'octocat' },
        'provider-token',
      ),
    ).resolves.toEqual({ kind: 'admit', isInternal: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
