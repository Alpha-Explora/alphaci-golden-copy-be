import { readFile } from 'node:fs/promises';

import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import type { CatalogService } from '../catalog/catalog.service.js';
import type { GithubService } from '#modules/pipelines/github/infrastructure/github.service.js';
import { ExistingReposService } from './existing-repos.service.js';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

const mockedReadFile = readFile as jest.MockedFunction<typeof readFile>;

const makeGithubService = () =>
  ({
    getInstallationAccessTokenForUser: jest.fn().mockResolvedValue('app-token'),
    getInstallationAccessTokenForUserRepo: jest
      .fn()
      .mockResolvedValue('app-token'),
    getFileContent: jest.fn().mockResolvedValue(
      JSON.stringify({
        dependencies: { next: '16.0.0' },
        devDependencies: { typescript: '5.0.0' },
      }),
    ),
    createBranch: jest.fn().mockResolvedValue(undefined),
    // Preflight reads (added 2026-08-18). Defaults describe the CLEAN repo:
    // default branch main, no protection, no Sonar, no uat — so the existing
    // assertions keep describing the same repository they always did.
    getRepo: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
    requiresPullRequestToPush: jest.fn().mockResolvedValue(false),
    listActionsSecretNames: jest.fn().mockResolvedValue(new Set<string>()),
    branchExists: jest.fn().mockResolvedValue(false),
    putFileContent: jest.fn().mockResolvedValue({
      commitSha: 'commit-sha',
      commitUrl: 'https://github.com/tone/app/commit/commit-sha',
    }),
    createPullRequest: jest.fn().mockResolvedValue({
      number: 42,
      htmlUrl: 'https://github.com/tone/app/pull/42',
    }),
  }) as unknown as GithubService;

const makeCatalogService = () =>
  ({
    getProjectOptions: jest.fn().mockReturnValue({
      recipes: [
        {
          id: 'standard',
          templateByProjectType: {
            nextjs: 'nextjs-service-pipeline',
            nestjs: 'nest-service-pipeline',
          },
        },
      ],
    }),
    getTemplateById: jest.fn().mockResolvedValue({
      id: 'nextjs-service-pipeline',
      name: 'Next.js Service',
      workflowPath: 'workflow-templates/nextjs-service-pipeline.yml',
    }),
  }) as unknown as CatalogService;

describe('ExistingReposService', () => {
  let githubService: GithubService;
  let service: ExistingReposService;
  let appRoleLookup: { findAppRole: jest.Mock };

  beforeEach(() => {
    githubService = makeGithubService();
    appRoleLookup = { findAppRole: jest.fn().mockResolvedValue('lead') };
    service = new ExistingReposService(
      githubService,
      makeCatalogService(),
      appRoleLookup as never,
    );
    mockedReadFile.mockResolvedValue(`
name: Service CI
on:
  workflow_dispatch:
    inputs: {}
jobs:
  pipeline:
    with: {}
`);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('discovers an existing repo and recommends a workflow plan', async () => {
    const result = await service.discover('user-1', 'oauth-user-token', {
      repoFullName: 'tone/app',
      baseBranch: 'main',
    });

    expect(
      githubService.getInstallationAccessTokenForUserRepo,
    ).toHaveBeenCalledWith('user-1', 'tone/app');
    expect(githubService.getFileContent).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      'package.json',
      'main',
    );
    expect(result).toMatchObject({
      repoFullName: 'tone/app',
      baseBranch: 'main',
      detectedProjectTypeId: 'nextjs',
      recommendedWorkflowRecipeId: 'standard',
      serviceName: 'app',
      servicePath: '.',
    });
  });

  it('creates a setup branch and pull request for an existing repo', async () => {
    const result = await service.setupPullRequest(
      'user-1',
      'oauth-user-token',
      {
        repoFullName: 'tone/app',
        baseBranch: 'dev',
        projectTypeId: 'nextjs',
        workflowRecipeId: 'standard',
        serviceName: 'app',
        servicePath: '.',
        outputFileName: 'ci.yml',
      },
    );

    expect(githubService.createBranch).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      'alphaci/app-ci',
      'dev',
    );
    expect(githubService.putFileContent).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      '.github/workflows/ci.yml',
      expect.stringContaining('app - Next.js Service'),
      'alphaci/app-ci',
      'ci: add ALPHACI workflow',
    );
    expect(githubService.createPullRequest).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      expect.objectContaining({
        head: 'alphaci/app-ci',
        base: 'dev',
      }),
    );
    expect(result).toEqual({
      repoFullName: 'tone/app',
      branchName: 'alphaci/app-ci',
      workflowPath: '.github/workflows/ci.yml',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/tone/app/pull/42',
    });
  });

  it.each([
    [{ dependencies: { '@nestjs/core': '11.0.0' } }, 'nestjs'],
    [{ dependencies: { react: '19.0.0' } }, 'react'],
    [{ dependencies: { express: '5.0.0' } }, 'nodejs'],
    [{ dependencies: { fastify: '5.0.0' } }, 'nodejs'],
    [{ dependencies: {} }, null],
  ])(
    'detects project type from package dependencies',
    async (pkg, expected) => {
      (githubService.getFileContent as jest.Mock).mockResolvedValueOnce(
        JSON.stringify(pkg),
      );

      await expect(
        service.discover('user-1', 'oauth-user-token', {
          repoFullName: 'tone/app',
        }),
      ).resolves.toMatchObject({
        baseBranch: 'main',
        detectedProjectTypeId: expected,
      });
    },
  );

  it('falls back to the OAuth token when no app installation token exists', async () => {
    (
      githubService.getInstallationAccessTokenForUserRepo as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.discover('user-1', 'oauth-token', {
      repoFullName: 'tone/app',
    });

    expect(githubService.getFileContent).toHaveBeenCalledWith(
      'oauth-token',
      'tone',
      'app',
      'package.json',
      'main',
    );
  });

  it('rejects discovery when no GitHub token source is available', async () => {
    (
      githubService.getInstallationAccessTokenForUserRepo as jest.Mock
    ).mockResolvedValueOnce(null);

    // Passing the caller check but with neither an installation nor a usable
    // OAuth token is impossible now: the OAuth token is required up front.
    await expect(
      service.discover('user-1', null, { repoFullName: 'tone/app' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(githubService.getRepo).not.toHaveBeenCalled();
    expect(githubService.getFileContent).not.toHaveBeenCalled();
  });

  describe('role and repository-access gates', () => {
    const setupDto = {
      repoFullName: 'tone/app',
      projectTypeId: 'nextjs',
      serviceName: 'app',
    };

    it.each(['member', 'qa'])(
      'refuses %s on discover and setup-pr with PROJECT_ROLE_FORBIDDEN, no GitHub call',
      async (role) => {
        for (const attempt of [
          () => {
            appRoleLookup.findAppRole.mockResolvedValueOnce(role);
            return service.discover('user-1', 'oauth', {
              repoFullName: 'tone/app',
            });
          },
          () => {
            appRoleLookup.findAppRole.mockResolvedValueOnce(role);
            return service.setupPullRequest('user-1', 'oauth', setupDto);
          },
        ]) {
          const error = await attempt().catch((e: unknown) => e);
          expect(error).toBeInstanceOf(ForbiddenException);
          expect((error as ForbiddenException).getResponse()).toMatchObject({
            code: 'PROJECT_ROLE_FORBIDDEN',
          });
        }
        expect(githubService.getRepo).not.toHaveBeenCalled();
        expect(githubService.createBranch).not.toHaveBeenCalled();
        expect(
          githubService.getInstallationAccessTokenForUserRepo,
        ).not.toHaveBeenCalled();
      },
    );

    it('fails closed when the role cannot be resolved', async () => {
      appRoleLookup.findAppRole.mockResolvedValueOnce(undefined);
      await expect(
        service.discover('user-1', 'oauth', { repoFullName: 'tone/app' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a repository the caller OAuth token cannot read, before the installation token is fetched', async () => {
      (githubService.getRepo as jest.Mock).mockRejectedValueOnce(
        new BadGatewayException('GitHub repo lookup failed (404): Not Found'),
      );
      const error = await service
        .discover('user-1', 'oauth', { repoFullName: 'victim/private' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'REPO_NOT_ACCESSIBLE',
      });
      expect(githubService.getRepo).toHaveBeenCalledWith(
        'oauth',
        'victim',
        'private',
      );
      expect(
        githubService.getInstallationAccessTokenForUserRepo,
      ).not.toHaveBeenCalled();
      expect(githubService.getFileContent).not.toHaveBeenCalled();
    });

    it('does the same for setup-pr: nothing is written to a repo the caller cannot read', async () => {
      (githubService.getRepo as jest.Mock).mockRejectedValueOnce(
        new BadGatewayException('GitHub repo lookup failed (403): denied'),
      );
      await expect(
        service.setupPullRequest('user-1', 'oauth', setupDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(githubService.createBranch).not.toHaveBeenCalled();
      expect(githubService.putFileContent).not.toHaveBeenCalled();
    });

    it('does not turn a GitHub outage into a 403', async () => {
      (githubService.getRepo as jest.Mock).mockRejectedValueOnce(
        new BadGatewayException('GitHub repo lookup failed (502): oops'),
      );
      await expect(
        service.discover('user-1', 'oauth', { repoFullName: 'tone/app' }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it.each(['admin', 'lead'])(
      'refuses an explicit main base for %s with MAIN_PR_RESTRICTED before any GitHub call',
      async (role) => {
        appRoleLookup.findAppRole.mockResolvedValueOnce(role);
        const error = await service
          .setupPullRequest('user-1', 'oauth', {
            ...setupDto,
            baseBranch: 'main',
          })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'MAIN_PR_RESTRICTED',
        });
        expect(githubService.getRepo).not.toHaveBeenCalled();
        expect(githubService.createBranch).not.toHaveBeenCalled();
      },
    );

    it('defaults the base to dev when none is given', async () => {
      (githubService.branchExists as jest.Mock).mockImplementation(
        (_t: string, _o: string, _r: string, b: string) =>
          Promise.resolve(b === 'dev' || b === 'uat'),
      );
      await service.setupPullRequest('user-1', 'oauth', setupDto);
      expect(githubService.createPullRequest).toHaveBeenCalledWith(
        'app-token',
        'tone',
        'app',
        expect.objectContaining({ base: 'dev' }),
      );
    });

    it('falls back to uat, and refuses with 409 when neither dev nor uat exists', async () => {
      (githubService.branchExists as jest.Mock).mockImplementation(
        (_t: string, _o: string, _r: string, b: string) =>
          Promise.resolve(b === 'uat'),
      );
      await service.setupPullRequest('user-1', 'oauth', setupDto);
      expect(githubService.createPullRequest).toHaveBeenCalledWith(
        'app-token',
        'tone',
        'app',
        expect.objectContaining({ base: 'uat' }),
      );

      (githubService.branchExists as jest.Mock).mockResolvedValue(false);
      await expect(
        service.setupPullRequest('user-1', 'oauth', setupDto),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('rejects malformed repo full names', async () => {
    await expect(
      service.discover('user-1', 'oauth-user-token', {
        repoFullName: 'tone',
      }),
    ).rejects.toThrow('Invalid repoFullName');
  });

  it('uses fallback template and sanitized output names for setup PRs', async () => {
    const result = await service.setupPullRequest(
      'user-1',
      'oauth-user-token',
      {
        repoFullName: 'tone/app',
        baseBranch: 'dev',
        projectTypeId: 'unknown',
        serviceName: 'Orders API',
        nodeVersion: '24',
        coverageThreshold: 90,
      },
    );

    expect(result).toMatchObject({
      branchName: 'alphaci/orders-api-ci',
      workflowPath: '.github/workflows/orders-api-unknown-standard.yml',
    });
    expect(githubService.putFileContent).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      '.github/workflows/orders-api-unknown-standard.yml',
      expect.stringContaining("default: '24'"),
      'alphaci/orders-api-ci',
      'ci: add ALPHACI workflow',
    );
  });

  it('throws when the selected workflow template does not exist', async () => {
    const catalogService = makeCatalogService();
    (catalogService.getTemplateById as jest.Mock).mockResolvedValueOnce(null);
    service = new ExistingReposService(
      githubService,
      catalogService,
      appRoleLookup as never,
    );

    await expect(
      service.setupPullRequest('user-1', 'oauth-user-token', {
        repoFullName: 'tone/app',
        baseBranch: 'dev',
        projectTypeId: 'nextjs',
        serviceName: 'app',
      }),
    ).rejects.toThrow("Template 'nextjs-service-pipeline' not found");
  });

  it('throws when workflow template YAML is not an object', async () => {
    mockedReadFile.mockResolvedValueOnce('- invalid');

    await expect(
      service.setupPullRequest('user-1', 'oauth-user-token', {
        repoFullName: 'tone/app',
        baseBranch: 'dev',
        projectTypeId: 'nextjs',
        serviceName: 'app',
      }),
    ).rejects.toThrow('Workflow template could not be parsed');
  });

  /*
   * ONBOARDING AN EXISTING REPOSITORY (2026-08-18).
   *
   * Every case below was a real defect before this suite existed: the push
   * branch was hardcoded to 'main', a failed setup left its secrets behind,
   * SonarCloud config was silently overwritten, and `uat` was never created so
   * half the pipeline sat dormant with no error.
   */
  describe('discover: preflight', () => {
    it('uses the repository OWN default branch instead of assuming main', async () => {
      githubService.getRepo = jest
        .fn()
        .mockResolvedValue({ defaultBranch: 'master' });

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/legacy',
      });

      expect(result.baseBranch).toBe('master');
    });

    it('still honours an explicit baseBranch from the caller', async () => {
      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
        baseBranch: 'develop',
      });

      expect(result.baseBranch).toBe('develop');
      // One call: the caller's own access check, not a default-branch lookup.
      expect(githubService.getRepo).toHaveBeenCalledTimes(1);
    });

    it('warns that a protected branch will reject the commit', async () => {
      githubService.requiresPullRequestToPush = jest
        .fn()
        .mockResolvedValue(true);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).toContain('branch_protected');
    });

    it('does NOT warn when protection cannot be read — an unknown is not a blocker', async () => {
      githubService.requiresPullRequestToPush = jest
        .fn()
        .mockResolvedValue(null);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).not.toContain(
        'branch_protected',
      );
    });

    it('warns that existing SonarCloud secrets will be left alone', async () => {
      githubService.listActionsSecretNames = jest
        .fn()
        .mockResolvedValue(new Set(['SONAR_TOKEN']));

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).toContain(
        'sonar_already_configured',
      );
    });

    it('says a uat branch will be created when the repository has none', async () => {
      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).toContain('uat_missing');
    });

    it('stays quiet about uat when the repository already has one', async () => {
      githubService.branchExists = jest.fn().mockResolvedValue(true);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).not.toContain('uat_missing');
    });

    it('tells the user to pick a stack when none could be detected', async () => {
      githubService.getFileContent = jest.fn().mockResolvedValue(null);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.detectedProjectTypeId).toBeNull();
      expect(result.warnings.map((w) => w.code)).toContain(
        'project_type_undetected',
      );
    });

    it('reports a clean repository with no warnings at all', async () => {
      githubService.branchExists = jest.fn().mockResolvedValue(true);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings).toEqual([]);
    });
  });
});
