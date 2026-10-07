import type { GithubProjectPort } from '#kernel/ports/github.port';
import { QaUatHeadsService, fingerprintHeads } from './qa-uat-heads.service';

const API = { projectId: 'p-api', name: 'api', repoFullName: 'acme/api' };
const WEB = { projectId: 'p-web', name: 'web', repoFullName: 'acme/web' };
const actor = { userId: 'u1', oauthToken: 'oauth' };

function setup(
  branches: Record<string, Array<{ name: string; commitSha: string }> | Error>,
) {
  const github = {
    getEnforcedOrg: jest.fn().mockReturnValue(null),
    getInstallationAccessTokenForUserRepo: jest.fn().mockResolvedValue(null),
    getOrganizationProvisioningContextByLogin: jest.fn(),
    listBranches: jest
      .fn()
      .mockImplementation((_token: string, repo: string) => {
        const result = branches[repo];
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result ?? []);
      }),
  } as unknown as jest.Mocked<GithubProjectPort>;
  return { github, service: new QaUatHeadsService(github) };
}

describe('QaUatHeadsService', () => {
  it('reads every repository and classifies ok / branch_missing / unreadable', async () => {
    const { service } = setup({
      'acme/api': [{ name: 'uat', commitSha: 'a'.repeat(40) }],
      'acme/web': [{ name: 'dev', commitSha: 'b'.repeat(40) }],
      'acme/boom': new Error('rate limited'),
    });
    const boom = {
      projectId: 'p-boom',
      name: 'boom',
      repoFullName: 'acme/boom',
    };

    const readings = await service.readHeads([API, WEB, boom], actor);

    expect(readings.map((reading) => reading.kind)).toEqual([
      'ok',
      'branch_missing',
      'unreadable',
    ]);
    expect(readings[0]).toMatchObject({ sha: 'a'.repeat(40) });
  });

  it('prefers the enforced-org installation token, then the per-repo installation, then the OAuth token', async () => {
    const { service, github } = setup({});
    github.getEnforcedOrg.mockReturnValue('acme');
    github.getOrganizationProvisioningContextByLogin.mockResolvedValue({
      accessToken: 'org-token',
    } as never);
    expect(await service.resolveReadToken('acme/api', 'u1', 'oauth')).toBe(
      'org-token',
    );

    github.getEnforcedOrg.mockReturnValue(null as never);
    github.getInstallationAccessTokenForUserRepo.mockResolvedValue(
      'inst-token',
    );
    expect(await service.resolveReadToken('acme/api', 'u1', 'oauth')).toBe(
      'inst-token',
    );

    github.getInstallationAccessTokenForUserRepo.mockResolvedValue(
      null as never,
    );
    expect(await service.resolveReadToken('acme/api', 'u1', 'oauth')).toBe(
      'oauth',
    );
    expect(await service.resolveReadToken('acme/api', 'u1', null)).toBeNull();
  });

  it('resolves the write credential as the App first, the caller token only as fallback, null with neither', async () => {
    const { service, github } = setup({});
    github.getEnforcedOrg.mockReturnValue('acme');
    github.getOrganizationProvisioningContextByLogin.mockResolvedValue({
      accessToken: 'org-token',
    } as never);
    expect(
      await service.resolveWriteCredential('acme/api', 'u1', 'oauth'),
    ).toEqual({ token: 'org-token', via: 'github_app' });
    expect(
      await service.resolveWriteCredential('acme/api', 'u1', null),
    ).toEqual({ token: 'org-token', via: 'github_app' });

    github.getEnforcedOrg.mockReturnValue(null as never);
    github.getInstallationAccessTokenForUserRepo.mockRejectedValue(
      new Error('no installation'),
    );
    expect(
      await service.resolveWriteCredential('acme/api', 'u1', 'oauth'),
    ).toEqual({ token: 'oauth', via: 'user_token' });
    expect(
      await service.resolveWriteCredential('acme/api', 'u1', null),
    ).toBeNull();
  });

  it('no token at all is unreadable, not an error', async () => {
    const { service, github } = setup({});

    const reading = await service.readHead(API, {
      userId: 'u1',
      oauthToken: null,
    });

    expect(reading.kind).toBe('unreadable');
    expect(github.listBranches).not.toHaveBeenCalled();
  });

  it('reuses a recent reading only when asked to, never for a fresh read', async () => {
    const { service, github } = setup({
      'acme/api': [{ name: 'uat', commitSha: 'a'.repeat(40) }],
    });

    await service.readHead(API, actor, { maxAgeMs: 60_000 });
    await service.readHead(API, actor, { maxAgeMs: 60_000 });
    expect(github.listBranches).toHaveBeenCalledTimes(1);

    await service.readHead(API, actor);
    expect(github.listBranches).toHaveBeenCalledTimes(2);
  });
});

describe('fingerprintHeads', () => {
  it('is order-independent, hex sha256, and changes when a head changes', () => {
    const a = fingerprintHeads([
      { projectId: 'p1', headSha: '1'.repeat(40) },
      { projectId: 'p2', headSha: '2'.repeat(40) },
    ]);
    const b = fingerprintHeads([
      { projectId: 'p2', headSha: '2'.repeat(40) },
      { projectId: 'p1', headSha: '1'.repeat(40) },
    ]);
    const c = fingerprintHeads([
      { projectId: 'p1', headSha: '1'.repeat(40) },
      { projectId: 'p2', headSha: '3'.repeat(40) },
    ]);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
