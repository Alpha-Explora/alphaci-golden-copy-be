import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { GithubController } from './github.controller.js';
import { GithubService } from '../infrastructure/github.service.js';
import type { Request } from 'express';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { APP_ROLE_LOOKUP } from '#kernel/ports/app-role.port';

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
    linkInstallationForUser: jest.fn().mockResolvedValue({
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
    ensurePullRequestProtection: jest
      .fn()
      .mockResolvedValue({ status: 'applied' }),
  }) as unknown as GithubService;

describe('GithubController', () => {
  let controller: GithubController;
  let service: GithubService;
  const appRoleLookup = { findAppRole: jest.fn() };

  beforeEach(async () => {
    service = makeGithubService();
    appRoleLookup.findAppRole.mockReset().mockResolvedValue('admin');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GithubController],
      providers: [
        { provide: GithubService, useValue: service },
        { provide: APP_ROLE_LOOKUP, useValue: appRoleLookup },
      ],
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
      controller.linkInstallation(makeRequest('gho_token'), {
        installationId: 123,
      }),
    ).resolves.toEqual({
      reposLinked: 3,
      repositorySelection: 'selected',
    });
    // The caller's own OAuth token travels with the request so the service can
    // prove the installation is theirs.
    expect(service.linkInstallationForUser).toHaveBeenCalledWith(
      'user-1',
      123,
      'gho_token',
    );
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
        branchesCreated: ['main', 'dev', 'uat'],
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
        'dev',
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
      expect(service.ensurePullRequestProtection).toHaveBeenCalledTimes(3);
      for (const [index, branch] of ['dev', 'uat', 'main'].entries()) {
        expect(service.ensurePullRequestProtection).toHaveBeenNthCalledWith(
          index + 1,
          'gh-token',
          'tone',
          'orders-api',
          branch,
          { seedStatusChecks: ['env-guard'] },
        );
      }
    });
  });

  describe('POST /github/repos role gate', () => {
    it.each(['lead', 'qa'])(
      'refuses %s with REPOSITORY_CREATE_FORBIDDEN before touching GitHub',
      async (role) => {
        appRoleLookup.findAppRole.mockResolvedValueOnce(role);
        const error = await controller
          .createRepo(makeRequest('gho'), { name: 'x' } as never)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'REPOSITORY_CREATE_FORBIDDEN',
          message: 'Developers create repositories inside a Project.',
        });
        expect(service.createRepo).not.toHaveBeenCalled();
      },
    );

    it('asks a member for a Project: a bare repository belongs to none (400 PROJECT_REQUIRED)', async () => {
      appRoleLookup.findAppRole.mockResolvedValueOnce('member');
      const error = await controller
        .createRepo(makeRequest('gho'), { name: 'x' } as never)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'PROJECT_REQUIRED',
        message: 'Choose the Project this repository belongs to.',
      });
      expect(service.createRepo).not.toHaveBeenCalled();
    });

    it('fails closed when the role cannot be resolved', async () => {
      appRoleLookup.findAppRole.mockResolvedValueOnce(undefined);
      await expect(
        controller.createRepo(makeRequest('gho'), { name: 'x' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.createRepo).not.toHaveBeenCalled();
    });

    it('lets an admin create a repository', async () => {
      appRoleLookup.findAppRole.mockResolvedValueOnce('admin');
      await expect(
        controller.createRepo(makeRequest('gho'), { name: 'x' } as never),
      ).resolves.toMatchObject({ defaultBranch: 'main' });
      expect(service.createRepo).toHaveBeenCalled();
    });
  });

  describe('POST /github/installations', () => {
    it('passes an absent OAuth token through so the service answers 401', async () => {
      await controller.linkInstallation(makeRequest(), { installationId: 1 });
      expect(service.linkInstallationForUser).toHaveBeenCalledWith(
        'user-1',
        1,
        undefined,
      );
    });
  });
});
