import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  decodeCommitCursor,
  encodeCommitCursor,
  ProjectCommitsService,
  pullRequestNumberFromMessage,
} from './project-commits.service';

const branch = (name: string) => ({ name, protected: false, commitSha: 'x' });

const commit = (sha: string, message: string) => ({
  sha,
  message,
  authorLogin: 'devone',
  authorName: 'Dev One',
  authoredAt: '2026-10-02T10:00:00Z',
  url: `https://github.com/o/r/commit/${sha}`,
});

describe('pullRequestNumberFromMessage', () => {
  it.each([
    ['feat: add commits (#123)', 123],
    ['Merge pull request #45 from o/feature/x', 45],
    ['fix: no number', null],
    ['Revert "x (#9)" (#10)', 9],
  ])('%s -> %s', (message, expected) => {
    expect(pullRequestNumberFromMessage(message)).toBe(expected);
  });
});

describe('commit cursor', () => {
  it('round-trips and rejects anything it did not issue', () => {
    expect(decodeCommitCursor(encodeCommitCursor(3))).toBe(3);
    for (const bad of ['', 'page:1', '!!!', encodeCommitCursor(1)]) {
      expect(() => decodeCommitCursor(bad)).toThrow(BadRequestException);
    }
  });
});

describe('ProjectCommitsService', () => {
  let projectsRepository: {
    findByIdAndUser: jest.Mock;
    findAppRole: jest.Mock;
  };
  let github: {
    listBranches: jest.Mock;
    listBranchHeadAuthors: jest.Mock;
    listCommits: jest.Mock;
    getRepo: jest.Mock;
  };
  let tokens: { userFirst: jest.Mock };
  let service: ProjectCommitsService;

  const call = (
    query: Parameters<ProjectCommitsService['listCommits']>[4] = {},
    oauth: string | null = 'oauth',
  ) => service.listCommits('project-1', 'user-1', oauth, 'devone', query);

  beforeEach(() => {
    projectsRepository = {
      findByIdAndUser: jest
        .fn()
        .mockResolvedValue({ id: 'project-1', repo_full_name: 'o/r' }),
      findAppRole: jest.fn().mockResolvedValue('admin'),
    };
    github = {
      listBranches: jest
        .fn()
        .mockResolvedValue(['zeta', 'main', 'dev', 'alpha', 'uat'].map(branch)),
      listBranchHeadAuthors: jest.fn().mockResolvedValue(new Map()),
      listCommits: jest.fn().mockResolvedValue({
        items: [
          commit('a'.repeat(40), 'feat: thing (#12)\n\nbody'),
          commit('b'.repeat(40), 'Merge pull request #7 from o/x'),
          commit('c'.repeat(40), 'chore: plain'),
        ],
        hasNextPage: true,
      }),
      getRepo: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
    };
    tokens = {
      userFirst: jest
        .fn()
        .mockImplementation(
          (_repo: string, _user: string, oauth: string | null) => [
            ...(oauth ? [() => Promise.resolve(oauth)] : []),
            () => Promise.resolve('install-tok'),
          ],
        ),
    };
    service = new ProjectCommitsService(
      projectsRepository as never,
      github as never,
      tokens as never,
    );
  });

  it('is 404 for a project the caller cannot see, before any GitHub call', async () => {
    projectsRepository.findByIdAndUser.mockResolvedValue(null);

    await expect(call()).rejects.toThrow(NotFoundException);
    expect(github.listBranches).not.toHaveBeenCalled();
  });

  it('defaults to dev, lists dev/uat/main first and shapes the items', async () => {
    const response = await call();

    expect(response.branch).toBe('dev');
    expect(response.branches).toEqual(['dev', 'uat', 'main', 'alpha', 'zeta']);
    expect(github.listCommits).toHaveBeenCalledWith('oauth', 'o/r', {
      branch: 'dev',
      perPage: 30,
      page: 1,
    });
    expect(response.items[0]).toEqual({
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      message: 'feat: thing (#12)',
      authorLogin: 'devone',
      authorName: 'Dev One',
      authoredAt: '2026-10-02T10:00:00Z',
      url: `https://github.com/o/r/commit/${'a'.repeat(40)}`,
      pullRequestNumber: 12,
    });
    expect(response.items.map((i) => i.pullRequestNumber)).toEqual([
      12,
      7,
      null,
    ]);
    expect(decodeCommitCursor(response.next ?? '')).toBe(2);
  });

  it('falls back to the repository default branch when there is no dev', async () => {
    github.listBranches.mockResolvedValue(['main', 'uat'].map(branch));
    github.getRepo.mockResolvedValue({ defaultBranch: 'main' });

    const response = await call();

    expect(response.branch).toBe('main');
  });

  it('pages with the opaque cursor and caps the limit at 100', async () => {
    github.listCommits.mockResolvedValue({ items: [], hasNextPage: false });

    const response = await call({
      branch: 'uat',
      limit: 500,
      before: encodeCommitCursor(4),
    });

    expect(github.listCommits).toHaveBeenCalledWith('oauth', 'o/r', {
      branch: 'uat',
      perPage: 100,
      page: 4,
    });
    expect(response.next).toBeNull();
  });

  it('rejects a branch the repository does not have', async () => {
    await expect(call({ branch: 'nope' })).rejects.toThrow(BadRequestException);
    expect(github.listCommits).not.toHaveBeenCalled();
  });

  it('shows a developer only the branches the Code tab shows them (never main)', async () => {
    projectsRepository.findAppRole.mockResolvedValue('member');
    github.listBranches.mockResolvedValue(
      ['dev', 'uat', 'main', 'feature/devone-x', 'feature/other-y'].map(branch),
    );

    const response = await call();
    expect(response.branches).toEqual(['dev', 'uat', 'feature/devone-x']);
    await expect(call({ branch: 'main' })).rejects.toThrow(BadRequestException);
  });

  describe('stale session token', () => {
    it('falls back to the installation token when GitHub rejects the user token', async () => {
      github.listBranches
        .mockRejectedValueOnce(
          new BadGatewayException('GitHub branch list failed (401): Bad'),
        )
        .mockResolvedValue(['dev'].map(branch));

      const response = await call();

      expect(response.branch).toBe('dev');
      expect(github.listBranches).toHaveBeenLastCalledWith(
        'install-tok',
        'o/r',
      );
    });

    it('maps a rejected commit read to the sign-in-again error when nothing else works', async () => {
      tokens.userFirst.mockReturnValue([() => Promise.resolve('oauth')]);
      github.listCommits.mockRejectedValue(
        new UnauthorizedException('GitHub no longer accepts your sign-in'),
      );

      const failure = call();
      await expect(failure).rejects.toThrow(UnauthorizedException);
      await expect(failure).rejects.toThrow('sign in again');
    });

    it('tells the caller to sign in when no token exists at all', async () => {
      tokens.userFirst.mockReturnValue([() => Promise.resolve(null)]);

      await expect(call({}, null)).rejects.toThrow('No usable GitHub token');
    });

    it('does not swallow other GitHub failures', async () => {
      github.listBranches.mockRejectedValue(
        new BadGatewayException('GitHub branch list failed (500): boom'),
      );

      await expect(call()).rejects.toThrow('(500)');
      expect(github.listBranches).toHaveBeenCalledTimes(1);
    });
  });
});
