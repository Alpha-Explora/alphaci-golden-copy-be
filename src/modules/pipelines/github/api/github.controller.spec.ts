import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { GithubController } from './github.controller.js';
import { GithubService } from '../infrastructure/github.service.js';
import type { Request } from 'express';

const fakeRepos = [
  {
    id: 1,
    name: 'my-repo',
    fullName: 'user/my-repo',
    private: false,
    description: null,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/user/my-repo',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const makeRequest = (githubToken?: string) =>
  ({
    session: {
      user: { id: 'user-1' },
      githubAccessToken: githubToken,
    },
  }) as unknown as Request;

const makeGithubService = () =>
  ({
    listRepos: jest.fn().mockResolvedValue(fakeRepos),
    getAppInstallUrl: jest
      .fn()
      .mockReturnValue('https://github.com/apps/flowci/installations/new'),
    getAppSlug: jest.fn().mockReturnValue('flowci'),
    linkInstallation: jest.fn().mockResolvedValue({
      reposLinked: 3,
      repositorySelection: 'selected',
    }),
    listLinkedRepos: jest.fn().mockResolvedValue(['tone/orders-api']),
    listInstallationAccounts: jest.fn().mockResolvedValue([
      {
        installationId: 123,
        accountLogin: 'tone',
        accountId: 456,
        repositorySelection: 'selected',
        reposLinked: 3,
      },
    ]),
    createRepo: jest.fn().mockResolvedValue({
      repoUrl: 'https://github.com/tone/orders-api',
      cloneUrl: 'https://github.com/tone/orders-api.git',
      ownerLogin: 'tone',
      repoName: 'orders-api',
    }),
    createBranch: jest.fn().mockResolvedValue(undefined),
    applyBranchProtection: jest.fn().mockResolvedValue(undefined),
  }) as unknown as GithubService;

describe('GithubController', () => {
  let controller: GithubController;
  let service: GithubService;

  beforeEach(async () => {
    service = makeGithubService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GithubController],
      providers: [{ provide: GithubService, useValue: service }],
    })
      .overrideGuard(
        require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
      )
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(GithubController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns the GitHub App installation URL', () => {
    expect(controller.getAppInstallUrl()).toEqual({
      installUrl: 'https://github.com/apps/flowci/installations/new',
      appSlug: 'flowci',
    });
  });

  it('links a GitHub App installation to the current user', async () => {
    await expect(
      controller.linkInstallation(makeRequest(), { installationId: 123 }),
    ).resolves.toEqual({
      reposLinked: 3,
      repositorySelection: 'selected',
    });
    expect(service.linkInstallation).toHaveBeenCalledWith('user-1', 123);
  });

  it('lists linked repos for the current GitHub App installation', async () => {
    await expect(controller.listLinkedRepos(makeRequest())).resolves.toEqual({
      repos: ['tone/orders-api'],
    });
    expect(service.listLinkedRepos).toHaveBeenCalledWith('user-1');
  });

  it('normalizes installation accounts for the frontend', async () => {
    await expect(
      controller.listInstallationAccounts(makeRequest()),
    ).resolves.toEqual({
      accounts: [
        {
          installationId: 123,
          accountLogin: 'tone',
          accountId: 456,
          repositorySelection: 'selected',
        },
      ],
    });
    expect(service.listInstallationAccounts).toHaveBeenCalledWith('user-1');
  });

  describe('tokenScopes', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns no-token diagnostics when OAuth token is missing', async () => {
      await expect(controller.tokenScopes(makeRequest())).resolves.toEqual({
        hasToken: false,
        scopes: null,
      });
    });

    it('returns OAuth scopes from GitHub response headers', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        headers: {
          get: jest.fn((name: string) =>
            name.toLowerCase() === 'x-oauth-scopes' ? 'repo, user:email' : null,
          ),
        },
      }) as never;

      await expect(
        controller.tokenScopes(makeRequest('gh-token')),
      ).resolves.toEqual({
        hasToken: true,
        scopes: ['repo', 'user:email'],
        status: 200,
        hasRepoScope: true,
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer gh-token',
          }),
        }),
      );
    });
  });

  describe('repos', () => {
    it('returns repos when access token is present', async () => {
      const req = makeRequest('gh-token-123');
      const result = await controller.repos(req);

      expect(service.listRepos).toHaveBeenCalledWith('gh-token-123');
      expect(result).toEqual({ repos: fakeRepos });
    });

    it('returns empty repos when no access token in session', async () => {
      const req = makeRequest(undefined);
      const result = await controller.repos(req);

      expect(service.listRepos).not.toHaveBeenCalled();
      expect(result).toEqual({ repos: [] });
    });
  });

  describe('createRepo', () => {
    it('returns an error contract when OAuth token is missing', async () => {
      await expect(
        controller.createRepo(makeRequest(), {
          repoName: 'orders-api',
          private: true,
        }),
      ).resolves.toEqual({
        error:
          'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      });
      expect(service.createRepo).not.toHaveBeenCalled();
    });

    it('creates default branches and protection for a new OAuth repo', async () => {
      await expect(
        controller.createRepo(makeRequest('gh-token'), {
          repoName: 'orders-api',
          private: true,
        }),
      ).resolves.toEqual({
        repoUrl: 'https://github.com/tone/orders-api',
        cloneUrl: 'https://github.com/tone/orders-api.git',
        defaultBranch: 'main',
        branchesCreated: ['main', 'develop', 'uat'],
      });

      expect(service.createRepo).toHaveBeenCalledWith('gh-token', {
        repoName: 'orders-api',
        private: true,
      });
      expect(service.createBranch).toHaveBeenCalledTimes(2);
      expect(service.createBranch).toHaveBeenNthCalledWith(
        1,
        'gh-token',
        'tone',
        'orders-api',
        'develop',
        'main',
      );
      expect(service.createBranch).toHaveBeenNthCalledWith(
        2,
        'gh-token',
        'tone',
        'orders-api',
        'uat',
        'main',
      );
      expect(service.applyBranchProtection).toHaveBeenCalledTimes(2);
      expect(service.applyBranchProtection).toHaveBeenNthCalledWith(
        1,
        'gh-token',
        'tone',
        'orders-api',
        'uat',
      );
      expect(service.applyBranchProtection).toHaveBeenNthCalledWith(
        2,
        'gh-token',
        'tone',
        'orders-api',
        'main',
      );
    });
  });
});
