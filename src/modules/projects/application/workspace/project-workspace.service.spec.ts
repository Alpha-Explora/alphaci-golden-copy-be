import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ProjectWorkspaceService } from './project-workspace.service';
import type { GithubService } from '#modules/pipelines/github/infrastructure/github.service';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher';

const ROW = { repo_full_name: 'Alpha-Explora/orders-api' };

function build(
  overrides: {
    row?: unknown;
    installationToken?: string | null;
    github?: Partial<GithubService>;
  } = {},
) {
  const findByIdAndUser = jest.fn(() =>
    Promise.resolve('row' in overrides ? overrides.row : ROW),
  );
  const getInstallationAccessTokenForUserRepo = jest.fn(() =>
    Promise.resolve(
      overrides.installationToken === undefined
        ? 'ghs_install'
        : overrides.installationToken,
    ),
  );

  const github = {
    getInstallationAccessTokenForUserRepo,
    // Default: no enforced org, so the per-user lookup and the OAuth fallback
    // keep the behaviour the tests below were written against. The
    // enforced-org path is exercised explicitly further down.
    getEnforcedOrg: jest.fn(() => ''),
    getOrganizationProvisioningContextByLogin: jest.fn(() =>
      Promise.resolve({
        accessToken: 'ghs_enforced_org',
        ownerLogin: 'Alpha-Explora',
      }),
    ),
    listBranches: jest.fn(() =>
      Promise.resolve([
        { name: 'develop', protected: false, commitSha: 'a' },
        { name: 'main', protected: true, commitSha: 'b' },
      ]),
    ),
    listRepoContents: jest.fn(() =>
      Promise.resolve({ path: '', ref: 'main', entries: [], file: null }),
    ),
    listWorkflowRuns: jest.fn(() => Promise.resolve([])),
    getWorkflowRunJobs: jest.fn(() => Promise.resolve([])),
    getJobLogs: jest.fn(() =>
      Promise.resolve({ content: 'x', truncated: false }),
    ),
    listPullRequests: jest.fn(() => Promise.resolve([])),
    getPullRequestFiles: jest.fn(() => Promise.resolve([])),
    ...overrides.github,
  } as unknown as GithubService;

  const repository = { findByIdAndUser } as unknown as ProjectsRepository;
  const recordProjectEvent = jest.fn(() => Promise.resolve());
  const audit = { recordProjectEvent } as unknown as AuditEventPublisher;

  return {
    service: new ProjectWorkspaceService(repository, github, audit),
    github,
    recordProjectEvent,
    findByIdAndUser,
    getInstallationAccessTokenForUserRepo,
  };
}

describe('ProjectWorkspaceService', () => {
  describe('access', () => {
    it('is a 404, not a 403, for a project the caller cannot see — the response must not confirm it exists', async () => {
      const { service } = build({ row: null });
      await expect(service.listBranches('p1', 'u1', 'gho_x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('checks the project BEFORE minting a token', async () => {
      const { service, getInstallationAccessTokenForUserRepo } = build({
        row: null,
      });
      await expect(service.listBranches('p1', 'u1', 'gho_x')).rejects.toThrow();
      expect(getInstallationAccessTokenForUserRepo).not.toHaveBeenCalled();
    });

    it('prefers the installation token over the caller OAuth token', async () => {
      const { service, github } = build({ installationToken: 'ghs_install' });
      await service.listBranches('p1', 'u1', 'gho_caller');
      expect(github.listBranches).toHaveBeenCalledWith(
        'ghs_install',
        ROW.repo_full_name,
      );
    });

    it('falls back to the OAuth token when there is no installation', async () => {
      const { service, github } = build({ installationToken: null });
      await service.listBranches('p1', 'u1', 'gho_caller');
      expect(github.listBranches).toHaveBeenCalledWith(
        'gho_caller',
        ROW.repo_full_name,
      );
    });

    it('refuses when neither token is available', async () => {
      const { service } = build({ installationToken: null });
      await expect(service.listBranches('p1', 'u1', null)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    /* github_app.github_installations is populated by this product's linking
     * flow and by `installation` webhooks. An App installed straight from
     * GitHub is absent from it, so the per-user lookup returns null and every
     * read used to fall through to OAuth — which cannot see the enforced org,
     * leaving each workspace tab reporting an unreadable repository against a
     * project that had provisioned fine. */
    it('reads through the enforced org installation with nothing linked to the user', async () => {
      const { service, github } = build({
        installationToken: null,
        github: { getEnforcedOrg: jest.fn(() => 'Alpha-Explora') },
      });

      await service.listBranches('p1', 'u1', null);

      expect(
        github.getOrganizationProvisioningContextByLogin,
      ).toHaveBeenCalledWith('Alpha-Explora');
      expect(github.listBranches).toHaveBeenCalledWith(
        'ghs_enforced_org',
        'Alpha-Explora/orders-api',
      );
    });

    it('leaves a repository outside the enforced org to the other strategies', async () => {
      const { service, github } = build({
        row: { repo_full_name: 'other-co/orders-api' },
        github: { getEnforcedOrg: jest.fn(() => 'Alpha-Explora') },
      });

      await service.listBranches('p1', 'u1', null);

      expect(
        github.getOrganizationProvisioningContextByLogin,
      ).not.toHaveBeenCalled();
      expect(github.listBranches).toHaveBeenCalledWith(
        'ghs_install',
        'other-co/orders-api',
      );
    });

    it('falls through to the other strategies when the enforced org lookup fails', async () => {
      const { service, github } = build({
        github: {
          getEnforcedOrg: jest.fn(() => 'Alpha-Explora'),
          getOrganizationProvisioningContextByLogin: jest.fn(() =>
            Promise.reject(new Error('App not installed')),
          ),
        },
      });

      await service.listBranches('p1', 'u1', null);

      // An unreachable App must not turn a readable repository into an error.
      expect(github.listBranches).toHaveBeenCalledWith(
        'ghs_install',
        'Alpha-Explora/orders-api',
      );
    });
  });

  describe('default branch', () => {
    it('prefers main over whatever GitHub happens to list first', async () => {
      const { service } = build();
      await expect(service.listBranches('p1', 'u1', null)).resolves.toEqual(
        expect.objectContaining({ defaultBranch: 'main' }),
      );
    });

    it('falls back to the first branch when none of the usual names exist', async () => {
      const { service } = build({
        github: {
          listBranches: jest.fn(() =>
            Promise.resolve([
              { name: 'trunk', protected: false, commitSha: 'a' },
            ]),
          ),
        },
      });
      await expect(service.listBranches('p1', 'u1', null)).resolves.toEqual(
        expect.objectContaining({ defaultBranch: 'trunk' }),
      );
    });

    it('never returns empty for a repository with no branches', async () => {
      const { service } = build({
        github: {
          listBranches: jest.fn(() => Promise.resolve([])),
        },
      });
      await expect(service.listBranches('p1', 'u1', null)).resolves.toEqual(
        expect.objectContaining({ defaultBranch: 'main' }),
      );
    });
  });

  describe('listFiles', () => {
    it('resolves the ref server-side when the browser has not got one yet', async () => {
      const { service, github } = build();
      await service.listFiles('p1', 'u1', null, '', null);
      expect(github.listRepoContents).toHaveBeenCalledWith(
        expect.any(String),
        ROW.repo_full_name,
        '',
        'main',
      );
    });

    it('does not spend a branch lookup when the ref is already known', async () => {
      const { service, github } = build();
      await service.listFiles('p1', 'u1', null, 'src', 'feature/x');
      expect(github.listBranches).not.toHaveBeenCalled();
      expect(github.listRepoContents).toHaveBeenCalledWith(
        expect.any(String),
        ROW.repo_full_name,
        'src',
        'feature/x',
      );
    });
  });

  describe('job logs', () => {
    it('reports an expired log as unavailable rather than throwing', async () => {
      const { service } = build({
        github: {
          getJobLogs: jest.fn(() => Promise.resolve(null)),
        },
      });
      await expect(service.getJobLog('p1', 'u1', null, 5)).resolves.toEqual({
        available: false,
        content: '',
        truncated: false,
      });
    });

    it('passes the truncation flag through so the UI can say the log was cut', async () => {
      const { service } = build({
        github: {
          getJobLogs: jest.fn(() =>
            Promise.resolve({ content: 'tail', truncated: true }),
          ),
        },
      });
      await expect(service.getJobLog('p1', 'u1', null, 5)).resolves.toEqual({
        available: true,
        content: 'tail',
        truncated: true,
      });
    });
  });

  describe('pull requests', () => {
    it('carries a link out to GitHub for everything this read-only view cannot do', async () => {
      const { service } = build();
      await expect(
        service.listPullRequests('p1', 'u1', null, 'all'),
      ).resolves.toEqual(
        expect.objectContaining({
          pullsUrl: 'https://github.com/Alpha-Explora/orders-api/pulls',
        }),
      );
    });
  });

  describe('compare branches', () => {
    const comparison = {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
      commits: [],
      files: [],
      filesTruncated: false,
    };

    it('refuses a branch compared with itself before spending a GitHub call', async () => {
      const compareBranches = jest.fn();
      const { service, findByIdAndUser } = build({
        github: { compareBranches } as Partial<GithubService>,
      });

      await expect(
        service.compareBranches('p1', 'u1', 'gho_x', 'main', 'main'),
      ).rejects.toThrow(BadRequestException);
      expect(findByIdAndUser).not.toHaveBeenCalled();
      expect(compareBranches).not.toHaveBeenCalled();
    });

    it('returns the comparison with any pull request already open for the pair', async () => {
      const open = { number: 12, headRef: 'feature', baseRef: 'main' };
      const { service, github } = build({
        github: {
          compareBranches: jest.fn(() => Promise.resolve(comparison)),
          findOpenPullRequest: jest.fn(() => Promise.resolve(open)),
        } as unknown as Partial<GithubService>,
      });

      const result = await service.compareBranches(
        'p1',
        'u1',
        'gho_x',
        'main',
        'feature',
      );

      expect(result).toEqual({
        repoFullName: 'Alpha-Explora/orders-api',
        base: 'main',
        head: 'feature',
        comparison,
        existingPullRequest: open,
      });
      // A read: the App token, same as every other workspace read.
      expect(github.compareBranches).toHaveBeenCalledWith(
        'ghs_install',
        'Alpha-Explora/orders-api',
        'main',
        'feature',
      );
    });

    it('is a 404 naming the branches when either does not exist', async () => {
      const { service } = build({
        github: {
          compareBranches: jest.fn(() => Promise.resolve(null)),
          findOpenPullRequest: jest.fn(() => Promise.resolve(null)),
        } as unknown as Partial<GithubService>,
      });

      await expect(
        service.compareBranches('p1', 'u1', 'gho_x', 'main', 'gone'),
      ).rejects.toThrow("Branch 'main' or 'gone' does not exist");
    });
  });

  describe('create pull request', () => {
    const INPUT = { base: 'main', head: 'feature', title: '  Add login  ' };
    const CREATED = {
      created: true as const,
      pullRequest: { number: 7, htmlUrl: 'https://github.com/o/r/pull/7' },
    };

    it("writes with the caller's own token even when an App token exists, so the person is the author", async () => {
      const openPullRequest = jest.fn(() => Promise.resolve(CREATED));
      const { service, getInstallationAccessTokenForUserRepo } = build({
        github: { openPullRequest } as unknown as Partial<GithubService>,
      });

      await service.createPullRequest('p1', 'u1', 'gho_user', INPUT);

      expect(openPullRequest).toHaveBeenCalledWith(
        'gho_user',
        'Alpha-Explora/orders-api',
        { title: 'Add login', base: 'main', head: 'feature', draft: false },
      );
      expect(getInstallationAccessTokenForUserRepo).not.toHaveBeenCalled();
    });

    it('refuses rather than falling back to the App when the sign-in has lapsed', async () => {
      const openPullRequest = jest.fn();
      const { service } = build({
        github: { openPullRequest } as unknown as Partial<GithubService>,
      });

      await expect(
        service.createPullRequest('p1', 'u1', null, INPUT),
      ).rejects.toThrow(UnauthorizedException);
      expect(openPullRequest).not.toHaveBeenCalled();
    });

    it('is a 404 for a project the caller cannot see, before any token is used', async () => {
      const openPullRequest = jest.fn();
      const { service } = build({
        row: null,
        github: { openPullRequest } as unknown as Partial<GithubService>,
      });

      await expect(
        service.createPullRequest('p1', 'u1', 'gho_user', INPUT),
      ).rejects.toThrow(NotFoundException);
      expect(openPullRequest).not.toHaveBeenCalled();
    });

    it('rejects a title that is only whitespace', async () => {
      const { service } = build();
      await expect(
        service.createPullRequest('p1', 'u1', 'gho_user', {
          ...INPUT,
          title: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('drops a whitespace-only body instead of sending it', async () => {
      const openPullRequest = jest.fn(() => Promise.resolve(CREATED));
      const { service } = build({
        github: { openPullRequest } as unknown as Partial<GithubService>,
      });

      await service.createPullRequest('p1', 'u1', 'gho_user', {
        ...INPUT,
        body: '  \n ',
      });

      expect(openPullRequest).toHaveBeenCalledWith(
        'gho_user',
        'Alpha-Explora/orders-api',
        expect.not.objectContaining({ body: expect.anything() }),
      );
    });

    it('audits a created pull request', async () => {
      const { service, recordProjectEvent } = build({
        github: {
          openPullRequest: jest.fn(() => Promise.resolve(CREATED)),
        } as unknown as Partial<GithubService>,
      });

      await service.createPullRequest('p1', 'u1', 'gho_user', INPUT);

      expect(recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'u1',
          projectId: 'p1',
          eventCode: 'pull_request_created',
        }),
      );
    });

    it("passes GitHub's refusal back unchanged and audits nothing", async () => {
      const refusal = {
        created: false as const,
        message: 'No commits between main and feature',
      };
      const { service, recordProjectEvent } = build({
        github: {
          openPullRequest: jest.fn(() => Promise.resolve(refusal)),
        } as unknown as Partial<GithubService>,
      });

      await expect(
        service.createPullRequest('p1', 'u1', 'gho_user', INPUT),
      ).resolves.toEqual(refusal);
      expect(recordProjectEvent).not.toHaveBeenCalled();
    });
  });
});
