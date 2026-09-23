import type { ConfigService } from '@nestjs/config';

import type { GithubOrganizationPort } from '#kernel/ports/github.port';
import {
  GithubOrgDirectorySource,
  ROSTER_CACHE_TTL_MS,
} from './github-org.directory-source';

const configWithOrg = (organization: string) =>
  ({
    getOrThrow: () => ({ directory: { source: 'github_org', organization } }),
  }) as unknown as ConfigService;

describe('GithubOrgDirectorySource', () => {
  const caller = { userId: 'lloyd-id', githubToken: 'gho_lloyd' };
  let github: jest.Mocked<
    Pick<GithubOrganizationPort, 'readOrganizationMembers'>
  >;

  beforeEach(() => {
    github = {
      readOrganizationMembers: jest
        .fn()
        .mockResolvedValue([{ login: 'bpramos-ae', avatarUrl: null }]),
    };
  });

  afterEach(() => jest.restoreAllMocks());

  const make = (organization = 'Alpha-Explora') =>
    new GithubOrgDirectorySource(
      configWithOrg(organization),
      github as unknown as GithubOrganizationPort,
    );

  it("reads the configured org with the caller's own token", async () => {
    await expect(make().read(caller)).resolves.toEqual({
      kind: 'ok',
      people: [{ login: 'bpramos-ae', avatarUrl: null }],
    });
    expect(github.readOrganizationMembers).toHaveBeenCalledWith({
      org: 'Alpha-Explora',
      userId: 'lloyd-id',
      userToken: 'gho_lloyd',
    });
  });

  it('describes itself by its org', () => {
    expect(make().describe()).toEqual({
      source: 'github_org',
      organization: 'Alpha-Explora',
    });
  });

  it('is unavailable, not empty, when no org is configured', async () => {
    const source = make('');

    await expect(source.read(caller)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('MEMBER_DIRECTORY_ORG'),
    });
    expect(source.describe().organization).toBeNull();
    expect(github.readOrganizationMembers).not.toHaveBeenCalled();
  });

  it('is unavailable with a way out when GitHub cannot be read', async () => {
    github.readOrganizationMembers.mockResolvedValue(null);

    await expect(make().read(caller)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('sign in again'),
    });
  });

  it('serves a fresh roster from cache, then re-reads once it expires', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const source = make();

    await source.read(caller);
    now.mockReturnValue(1_000 + ROSTER_CACHE_TTL_MS - 1);
    await source.read(caller);
    expect(github.readOrganizationMembers).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000 + ROSTER_CACHE_TTL_MS);
    await source.read(caller);
    expect(github.readOrganizationMembers).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read', async () => {
    github.readOrganizationMembers.mockResolvedValueOnce(null);
    const source = make();

    await source.read(caller);
    await source.read(caller);

    expect(github.readOrganizationMembers).toHaveBeenCalledTimes(2);
  });
});
