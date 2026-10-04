import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { ProjectWorkspaceService } from './project-workspace.service';
import type { GithubService } from '#modules/pipelines/github/infrastructure/github.service';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

const ROW = { repo_full_name: 'Alpha-Explora/orders-api' };

function build(
  overrides: {
    row?: unknown;
    installationToken?: string | null;
    github?: Partial<GithubService>;
    appRole?: PlatformAppRole;
  } = {},
) {
  const findByIdAndUser = jest.fn(() =>
    Promise.resolve('row' in overrides ? overrides.row : ROW),
  );
  const findAppRole = jest.fn(() =>
    Promise.resolve(overrides.appRole ?? 'lead'),
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
    listBranchHeadAuthors: jest.fn(() => Promise.resolve(new Map())),
    listRepoContents: jest.fn(() =>
      Promise.resolve({ path: '', ref: 'main', entries: [], file: null }),
    ),
    listWorkflowRuns: jest.fn(() => Promise.resolve([])),
    getWorkflowRunJobs: jest.fn(() => Promise.resolve([])),
    getJobLogs: jest.fn(() =>
      Promise.resolve({ status: 'ok', content: 'x', truncated: false }),
    ),
    listPullRequests: jest.fn(() => Promise.resolve([])),
    getPullRequestFiles: jest.fn(() => Promise.resolve([])),
    // Default base is a non-production branch so the merge-role gate does
    // not interfere with tests unrelated to it; the production-branch and
    // role-forbidden paths are exercised explicitly below.
    getPullRequest: jest.fn(() =>
      Promise.resolve({
        number: 7,
        title: 'PR',
        state: 'open',
        draft: false,
        merged: false,
        htmlUrl: 'https://github.com/o/r/pull/7',
        headRef: 'feature',
        baseRef: 'dev',
        author: null,
        authorAvatarUrl: null,
        createdAt: '',
        updatedAt: '',
        additions: null,
        deletions: null,
        changedFiles: null,
        mergeable: true,
        mergeableState: 'clean',
        headSha: 'sha123',
        body: null,
      }),
    ),
    ...overrides.github,
  } as unknown as GithubService;

  const repository = {
    findByIdAndUser,
    findAppRole,
  } as unknown as ProjectsRepository;
  const recordProjectEvent = jest.fn(() => Promise.resolve());
  const audit = { recordProjectEvent } as unknown as AuditEventPublisher;

  return {
    service: new ProjectWorkspaceService(repository, github, audit),
    github,
    recordProjectEvent,
    findByIdAndUser,
    findAppRole,
    getInstallationAccessTokenForUserRepo,
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
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

    it('lists every branch for a lead and keeps the default branch', async () => {
      const { service } = build({ appRole: 'lead' });
      const result = await service.listBranches('p1', 'u1', 'gho_x', 'alice');
      expect(result.branches.map((x) => x.name)).toEqual(['develop', 'main']);
      expect(result.defaultBranch).toBe('main');
    });

    it('hides main from a member and queries authors once', async () => {
      const { service, github } = build({
        appRole: 'member',
        github: {
          listBranches: jest.fn(() =>
            Promise.resolve([
              { name: 'dev', protected: false, commitSha: 'a' },
              { name: 'main', protected: true, commitSha: 'b' },
              { name: 'fix/x', protected: false, commitSha: 'c' },
            ]),
          ),
          listBranchHeadAuthors: jest.fn(() =>
            Promise.resolve(new Map([['fix/x', 'Alice']])),
          ),
        } as unknown as Partial<GithubService>,
      });
      const result = await service.listBranches('p1', 'u1', 'gho_x', 'alice');
      expect(result.branches.map((x) => x.name)).toEqual(['dev', 'fix/x']);
      expect(result.defaultBranch).toBe('main');
      expect(github.listBranchHeadAuthors).toHaveBeenCalledTimes(1);
    });

    it('falls back to name matching when the author lookup fails', async () => {
      const { service } = build({
        appRole: 'member',
        github: {
          listBranches: jest.fn(() =>
            Promise.resolve([
              { name: 'dev', protected: false, commitSha: 'a' },
              { name: 'feature/alice-a', protected: false, commitSha: 'b' },
              { name: 'fix/x', protected: false, commitSha: 'c' },
            ]),
          ),
          listBranchHeadAuthors: jest.fn(() =>
            Promise.reject(new Error('rate limited')),
          ),
        } as unknown as Partial<GithubService>,
      });
      const result = await service.listBranches('p1', 'u1', 'gho_x', 'alice');
      expect(result.branches.map((x) => x.name)).toEqual([
        'dev',
        'feature/alice-a',
      ]);
    });

    it('does not query authors for non-members', async () => {
      const { service, github } = build({ appRole: 'qa' });
      await service.listBranches('p1', 'u1', 'gho_x', 'alice');
      expect(github.listBranchHeadAuthors).not.toHaveBeenCalled();
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
          getJobLogs: jest.fn(() => Promise.resolve({ status: 'expired' })),
        },
      });
      await expect(service.getJobLog('p1', 'u1', null, 5)).resolves.toEqual({
        available: false,
        content: '',
        truncated: false,
        reason: 'log-expired',
      });
    });

    it('says the token cannot read the log, rather than that it expired', async () => {
      const { service } = build({
        github: {
          getJobLogs: jest.fn(() => Promise.resolve({ status: 'no-access' })),
        },
      });
      await expect(service.getJobLog('p1', 'u1', null, 5)).resolves.toEqual({
        available: false,
        content: '',
        truncated: false,
        reason: 'log-no-access',
      });
    });

    it('does not add a reason to a log that was read', async () => {
      const { service } = build();
      const result = await service.getJobLog('p1', 'u1', null, 5);
      expect(result).toEqual({
        available: true,
        content: 'x',
        truncated: false,
      });
      expect(result).not.toHaveProperty('reason');
    });

    it('passes the truncation flag through so the UI can say the log was cut', async () => {
      const { service } = build({
        github: {
          getJobLogs: jest.fn(() =>
            Promise.resolve({ status: 'ok', content: 'tail', truncated: true }),
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

  describe('run failure log', () => {
    const job = (
      id: number,
      name: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      name,
      status: 'completed',
      conclusion: 'failure',
      startedAt: null,
      completedAt: new Date().toISOString(),
      htmlUrl: `https://github.com/o/r/actions/runs/1/job/${String(id)}`,
      steps: [],
      ...overrides,
    });

    const READ_ORG =
      "GraphQL: Your token has not been granted the required scopes to execute this query. The 'login' field requires one of the following scopes: ['read:org'].";

    const logOf = (...lines: string[]) => ({
      status: 'ok' as const,
      content: [...lines, '##[error]Process completed with exit code 1.'].join(
        '\n',
      ),
      truncated: false,
    });

    it('explains every failed job, including ones outside the report', async () => {
      const { service, github } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() =>
            Promise.resolve([
              job(1, 'quality / Lint', {
                steps: [
                  {
                    name: 'Run eslint',
                    status: 'completed',
                    conclusion: 'failure',
                    number: 3,
                    startedAt: null,
                    completedAt: null,
                  },
                ],
              }),
              job(2, 'build / Compile', { conclusion: 'success' }),
              job(3, 'promote-to-uat / Create Promotion PR'),
              job(4, 'production-gate', { conclusion: 'timed_out' }),
            ]),
          ),
          getJobLogs: jest.fn((_t: string, _r: string, jobId: number) =>
            Promise.resolve(
              jobId === 3
                ? logOf(READ_ORG)
                : logOf(`failure of job ${String(jobId)}`),
            ),
          ),
        },
      });

      const result = await service.getRunFailureLog('p1', 'u1', null, 9);

      expect(github.getJobLogs).toHaveBeenCalledTimes(3);
      expect(result.failures.map((f) => f.jobId)).toEqual([1, 3, 4]);
      const promotion = result.failures[1]!;
      expect(promotion.jobName).toBe('promote-to-uat / Create Promotion PR');
      expect(promotion.lines.join('\n')).toContain("'read:org'");
      expect(promotion.hint).toMatch(/missing the read:org scope/);
      expect(promotion.foundErrorMarker).toBe(true);
      // A failure with no recognisable signature carries no hint at all.
      expect(result.failures[2]).not.toHaveProperty('hint');
      expect(result.failures[0]!.stepName).toBe('Run eslint');
    });

    it('keeps the top-level fields populated from the first failure', async () => {
      const { service } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() =>
            Promise.resolve([job(3, 'promote'), job(4, 'gate')]),
          ),
          getJobLogs: jest.fn(() => Promise.resolve(logOf(READ_ORG))),
        },
      });

      const result = await service.getRunFailureLog('p1', 'u1', null, 9);

      expect(result).toMatchObject({
        available: true,
        jobId: 3,
        jobName: 'promote',
        jobUrl: 'https://github.com/o/r/actions/runs/1/job/3',
        truncated: false,
        foundErrorMarker: true,
      });
      expect(result.hint).toContain('read:org');
      expect(result.lines).toEqual(result.failures[0]!.lines);
      expect(result).not.toHaveProperty('reason');
      expect(result).not.toHaveProperty('omittedFailures');
    });

    it('answers no-failed-job with an empty failures list', async () => {
      const { service, github } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() =>
            Promise.resolve([job(1, 'ok', { conclusion: 'success' })]),
          ),
        },
      });
      await expect(
        service.getRunFailureLog('p1', 'u1', null, 9),
      ).resolves.toEqual({
        available: false,
        reason: 'no-failed-job',
        failures: [],
      });
      expect(github.getJobLogs).not.toHaveBeenCalled();
    });

    it('ignores cancelled jobs, which are a consequence and not a cause', async () => {
      const { service } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() =>
            Promise.resolve([
              job(1, 'was cancelled', { conclusion: 'cancelled' }),
            ]),
          ),
        },
      });
      const result = await service.getRunFailureLog('p1', 'u1', null, 9);
      expect(result.reason).toBe('no-failed-job');
    });

    it('reports a 410 log as expired', async () => {
      const { service } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() => Promise.resolve([job(1, 'a')])),
          getJobLogs: jest.fn(() => Promise.resolve({ status: 'expired' })),
        },
      });
      const result = await service.getRunFailureLog('p1', 'u1', null, 9);
      expect(result).toMatchObject({
        available: false,
        reason: 'log-expired',
      });
      expect(result.failures[0]).toMatchObject({
        reason: 'log-expired',
        lines: [],
      });
    });

    it('reports a 403/404 on a recent job as no access, not as expired', async () => {
      const { service } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() => Promise.resolve([job(1, 'a')])),
          getJobLogs: jest.fn(() => Promise.resolve({ status: 'no-access' })),
        },
      });
      const result = await service.getRunFailureLog('p1', 'u1', null, 9);
      expect(result).toMatchObject({
        available: false,
        reason: 'log-no-access',
      });
      expect(result.failures[0]!.reason).toBe('log-no-access');
    });

    it('treats a 404 on a job past the retention window as expired', async () => {
      const old = new Date(
        Date.now() - 100 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { service } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() =>
            Promise.resolve([job(1, 'a', { completedAt: old })]),
          ),
          getJobLogs: jest.fn(() => Promise.resolve({ status: 'no-access' })),
        },
      });
      const result = await service.getRunFailureLog('p1', 'u1', null, 9);
      expect(result.failures[0]!.reason).toBe('log-expired');
    });

    it('keeps explaining the other jobs when one log is unreadable', async () => {
      const { service } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() =>
            Promise.resolve([job(1, 'a'), job(2, 'b')]),
          ),
          getJobLogs: jest.fn((_t: string, _r: string, jobId: number) =>
            Promise.resolve(
              jobId === 1 ? { status: 'expired' } : logOf('real error'),
            ),
          ),
        },
      });
      const result = await service.getRunFailureLog('p1', 'u1', null, 9);
      expect(result.failures[0]!.reason).toBe('log-expired');
      expect(result.failures[1]!.lines.join('\n')).toContain('real error');
      expect(result.failures[1]).not.toHaveProperty('reason');
    });

    it('caps the jobs explained at ten and says how many were left out', async () => {
      const jobs = Array.from({ length: 13 }, (_, i) =>
        job(i + 1, `job ${String(i)}`),
      );
      const { service, github } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() => Promise.resolve(jobs)),
          getJobLogs: jest.fn(() => Promise.resolve(logOf('boom'))),
        },
      });
      const result = await service.getRunFailureLog('p1', 'u1', null, 9);
      expect(result.failures).toHaveLength(10);
      expect(result.omittedFailures).toBe(3);
      expect(github.getJobLogs).toHaveBeenCalledTimes(10);
    });

    it('never downloads more than three logs at once', async () => {
      let inFlight = 0;
      let peak = 0;
      const jobs = Array.from({ length: 8 }, (_, i) =>
        job(i + 1, `job ${String(i)}`),
      );
      const { service } = build({
        github: {
          getWorkflowRunJobs: jest.fn(() => Promise.resolve(jobs)),
          getJobLogs: jest.fn(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return logOf('boom');
          }),
        },
      });
      await service.getRunFailureLog('p1', 'u1', null, 9);
      expect(peak).toBe(3);
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
    // Not 'main': that base is refused for every role (see the dedicated
    // tests below), so the other tests in this block — which are about
    // token/title/body/audit behaviour, not the base-branch gate — use a
    // non-production branch.
    const INPUT = { base: 'dev', head: 'feature', title: '  Add login  ' };
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
        { title: 'Add login', base: 'dev', head: 'feature', draft: false },
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

    it('refuses a pull request into main for every role, including lead/admin', async () => {
      const openPullRequest = jest.fn();
      const { service } = build({
        appRole: 'admin',
        github: { openPullRequest } as unknown as Partial<GithubService>,
      });

      const error = await caught(
        service.createPullRequest('p1', 'u1', 'gho_user', {
          ...INPUT,
          base: 'main',
        }),
      );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'MAIN_PR_RESTRICTED',
      });
      expect(openPullRequest).not.toHaveBeenCalled();
    });

    it('refuses a qa persona opening a pull request into a non-production branch', async () => {
      const openPullRequest = jest.fn();
      const { service } = build({
        appRole: 'qa',
        github: { openPullRequest } as unknown as Partial<GithubService>,
      });

      const error = await caught(
        service.createPullRequest('p1', 'u1', 'gho_user', INPUT),
      );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'PR_ROLE_FORBIDDEN',
      });
      expect(openPullRequest).not.toHaveBeenCalled();
    });

    it.each(['admin', 'lead', 'member'] as const)(
      'allows %s to open a pull request into a non-production branch',
      async (appRole) => {
        const { service } = build({
          appRole,
          github: {
            openPullRequest: jest.fn(() => Promise.resolve(CREATED)),
          } as unknown as Partial<GithubService>,
        });

        await expect(
          service.createPullRequest('p1', 'u1', 'gho_user', INPUT),
        ).resolves.toEqual(CREATED);
      },
    );
  });

  describe('developer pull request routes', () => {
    const CREATED = {
      created: true as const,
      pullRequest: { number: 7, htmlUrl: 'https://github.com/o/r/pull/7' },
    };
    const ROUTE_RESTRICTED = {
      statusCode: 403,
      code: 'PR_ROUTE_RESTRICTED',
      message:
        'Developers open pull requests from a feature branch into dev, and from dev into uat.',
    };

    it.each([
      ['feature', 'uat'],
      ['uat', 'dev'],
    ])('refuses a member opening %s -> %s', async (head, base) => {
      const openPullRequest = jest.fn();
      const { service } = build({
        appRole: 'member',
        github: { openPullRequest } as unknown as Partial<GithubService>,
      });

      const error = await caught(
        service.createPullRequest('p1', 'u1', 'gho_user', {
          base,
          head,
          title: 't',
        }),
      );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject(
        ROUTE_RESTRICTED,
      );
      expect(openPullRequest).not.toHaveBeenCalled();
    });

    it('allows a member to open dev -> uat', async () => {
      const { service } = build({
        appRole: 'member',
        github: {
          openPullRequest: jest.fn(() => Promise.resolve(CREATED)),
        } as unknown as Partial<GithubService>,
      });

      await expect(
        service.createPullRequest('p1', 'u1', 'gho_user', {
          base: 'uat',
          head: 'dev',
          title: 't',
        }),
      ).resolves.toEqual(CREATED);
    });

    it('allows a lead to open feature -> uat', async () => {
      const { service } = build({
        appRole: 'lead',
        github: {
          openPullRequest: jest.fn(() => Promise.resolve(CREATED)),
        } as unknown as Partial<GithubService>,
      });

      await expect(
        service.createPullRequest('p1', 'u1', 'gho_user', {
          base: 'uat',
          head: 'feature',
          title: 't',
        }),
      ).resolves.toEqual(CREATED);
    });

    it.each([
      ['feature', 'uat'],
      ['uat', 'dev'],
    ])(
      'refuses a member merging %s -> %s, reading the head from the PR',
      async (headRef, baseRef) => {
        const mergePullRequest = jest.fn();
        const { service } = build({
          appRole: 'member',
          github: {
            mergePullRequest,
            getPullRequest: jest.fn(() =>
              Promise.resolve({ number: 7, headRef, baseRef }),
            ),
          } as unknown as Partial<GithubService>,
        });

        const error = await caught(
          service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge'),
        );

        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject(
          ROUTE_RESTRICTED,
        );
        expect(mergePullRequest).not.toHaveBeenCalled();
      },
    );

    it('allows a member to merge dev -> uat', async () => {
      const { service } = build({
        appRole: 'member',
        github: {
          mergePullRequest: jest.fn(() =>
            Promise.resolve({ merged: true, message: 'ok', sha: 'a' }),
          ),
          getPullRequest: jest.fn(() =>
            Promise.resolve({ number: 7, headRef: 'dev', baseRef: 'uat' }),
          ),
        } as unknown as Partial<GithubService>,
      });

      await expect(
        service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge'),
      ).resolves.toMatchObject({ merged: true });
    });
  });

  describe('merge pull request', () => {
    const MERGED = { merged: true, message: 'Merged.', sha: 'abc123' };

    it("merges with the caller's own token, so GitHub records the person and checks their access", async () => {
      const mergePullRequest = jest.fn(() => Promise.resolve(MERGED));
      const { service, getInstallationAccessTokenForUserRepo } = build({
        github: { mergePullRequest } as unknown as Partial<GithubService>,
      });

      await service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'squash');

      expect(mergePullRequest).toHaveBeenCalledWith(
        'gho_user',
        'Alpha-Explora/orders-api',
        7,
        { method: 'squash' },
      );
      expect(getInstallationAccessTokenForUserRepo).not.toHaveBeenCalled();
    });

    it('refuses rather than merging as the App when the sign-in has lapsed', async () => {
      const mergePullRequest = jest.fn();
      const { service } = build({
        github: { mergePullRequest } as unknown as Partial<GithubService>,
      });

      await expect(
        service.mergePullRequest('p1', 'u1', null, 7, 'merge'),
      ).rejects.toThrow('Sign in again to merge pull requests.');
      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    it('audits a merge that happened', async () => {
      const { service, recordProjectEvent } = build({
        github: {
          mergePullRequest: jest.fn(() => Promise.resolve(MERGED)),
        } as unknown as Partial<GithubService>,
      });

      await service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge');

      expect(recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'u1',
          projectId: 'p1',
          eventCode: 'pull_request_merged',
        }),
      );
    });

    it("passes GitHub's refusal back and audits nothing", async () => {
      const refusal = {
        merged: false,
        message: 'Pull Request is not mergeable',
        sha: null,
      };
      const { service, recordProjectEvent } = build({
        github: {
          mergePullRequest: jest.fn(() => Promise.resolve(refusal)),
        } as unknown as Partial<GithubService>,
      });

      await expect(
        service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge'),
      ).resolves.toEqual(refusal);
      expect(recordProjectEvent).not.toHaveBeenCalled();
    });

    it('is a 404 when the pull request itself cannot be found', async () => {
      const mergePullRequest = jest.fn();
      const { service } = build({
        github: {
          mergePullRequest,
          getPullRequest: jest.fn(() => Promise.resolve(null)),
        } as unknown as Partial<GithubService>,
      });

      await expect(
        service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge'),
      ).rejects.toThrow(NotFoundException);
      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses a merge into main for every role, including lead/admin — that only happens via QA Studio', async () => {
      const mergePullRequest = jest.fn();
      const { service } = build({
        appRole: 'admin',
        github: {
          mergePullRequest,
          getPullRequest: jest.fn(() =>
            Promise.resolve({ number: 7, baseRef: 'main', headRef: 'uat' }),
          ),
        } as unknown as Partial<GithubService>,
      });

      const error = await caught(
        service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge'),
      );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'MAIN_MERGE_VIA_QA_STUDIO',
      });
      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses a qa persona merging a pull request into a non-production branch', async () => {
      const mergePullRequest = jest.fn();
      const { service } = build({
        appRole: 'qa',
        github: { mergePullRequest } as unknown as Partial<GithubService>,
      });

      const error = await caught(
        service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge'),
      );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'PR_ROLE_FORBIDDEN',
      });
      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    it.each(['admin', 'lead', 'member'] as const)(
      'allows %s to merge a pull request into a non-production branch',
      async (appRole) => {
        const { service } = build({
          appRole,
          github: {
            mergePullRequest: jest.fn(() => Promise.resolve(MERGED)),
          } as unknown as Partial<GithubService>,
        });

        await expect(
          service.mergePullRequest('p1', 'u1', 'gho_user', 7, 'merge'),
        ).resolves.toEqual(MERGED);
      },
    );
  });
});
