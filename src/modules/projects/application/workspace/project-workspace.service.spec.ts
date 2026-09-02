import { NotFoundException, UnauthorizedException } from '@nestjs/common';

import { ProjectWorkspaceService } from './project-workspace.service';
import type { GithubService } from '#modules/pipelines/github/github.service';
import type { ProjectsRepository } from '../../projects.repository';

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

  return {
    service: new ProjectWorkspaceService(repository, github),
    github,
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
});
