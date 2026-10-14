import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { GithubProjectPort } from '#kernel/ports/github.port';
import {
  fakeIterations,
  iterationRow,
} from '../../__fixtures__/project-iterations';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import type { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import type { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type {
  QaProjectContext,
  QaProjectContextService,
} from '../qa-checklists/qa-project-context.service';
import { QaPromotionService } from './qa-promotion.service';
import type { QaUatHeadsService } from './qa-uat-heads.service';

const SHA_API = 'a'.repeat(40);
const SHA_WEB = 'b'.repeat(40);
const MOVED = 'c'.repeat(40);

const actor = { userId: 'lead-1', userLogin: 'lead', oauthToken: 'gho_token' };

const API = { projectId: 'p-api', name: 'api', repoFullName: 'acme/api' };
const WEB = { projectId: 'p-web', name: 'web', repoFullName: 'acme/web' };

const folder = (): QaProjectContext => ({
  deliveryProjectId: 'dp-1',
  groupId: 'group-1',
  name: 'Checkout',
  repositories: [API, WEB],
});

type HeadMap = Record<string, string | null>;

function setup({
  role = 'lead',
  filed = true,
  heads = { 'acme/api': SHA_API, 'acme/web': SHA_WEB },
  installationToken = 'app-token' as string | null,
  requirementCount = 2,
  verdict = 'APPROVED',
  covered = [
    { project_id: 'p-api', head_sha: SHA_API },
    { project_id: 'p-web', head_sha: SHA_WEB },
  ],
  pullRequest = null,
}: {
  role?: PlatformAppRole;
  filed?: boolean;
  heads?: HeadMap;
  /** The GitHub App installation token; null = no installation resolves. */
  installationToken?: string | null;
  requirementCount?: number;
  verdict?: 'APPROVED' | 'REJECTED' | 'CONDITIONAL' | null;
  covered?: Array<{ project_id: string; head_sha: string }>;
  pullRequest?: { number: number; htmlUrl: string; headSha: string } | null;
} = {}) {
  const access = {
    findVisibleProject: jest.fn().mockResolvedValue({
      id: 'p-api',
      repo_full_name: 'acme/api',
      service_name: 'api',
      workspace_id: 'group-1',
    }),
    findAppRole: jest.fn().mockResolvedValue(role),
    listWorkspaceLeadIds: jest.fn().mockResolvedValue(['lead-1', 'lead-2']),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    findProjectOfRepository: jest
      .fn()
      .mockResolvedValue(filed ? folder() : null),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const requirements = {
    listActiveByIteration: jest.fn().mockResolvedValue(
      Array.from({ length: requirementCount }, (_, i) => ({
        id: `req-${i}`,
        name: `Requirement ${i}`,
      })),
    ),
    requirementsChangedSince: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<QaRequirementsRepository>;
  const projectRuns = {
    findLatestSignedOff: jest.fn().mockResolvedValue(
      verdict === null && covered.length === 0
        ? null
        : {
            run: { id: 'run-1' },
            signoff: { verdict, signed_at: '2026-10-01T00:00:00Z' },
            repositories: covered.map((row) => ({ run_id: 'run-1', ...row })),
          },
    ),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const readOne = (repository: { repoFullName: string }) => {
    const sha = heads[repository.repoFullName];
    return sha
      ? { kind: 'ok', repository, sha }
      : { kind: 'unreadable', repository };
  };
  const headsService = {
    readHeads: jest
      .fn()
      .mockImplementation((repos: Array<{ repoFullName: string }>) =>
        Promise.resolve(repos.map(readOne)),
      ),
    readHead: jest
      .fn()
      .mockImplementation((repo: { repoFullName: string }) =>
        Promise.resolve(readOne(repo)),
      ),
    resolveReadToken: jest.fn().mockResolvedValue('read-token'),
    resolveWriteCredential: jest
      .fn()
      .mockImplementation(
        (_repo: string, _userId: string, oauthToken: string | null) =>
          Promise.resolve(
            installationToken
              ? { token: installationToken, via: 'github_app' }
              : oauthToken
                ? { token: oauthToken, via: 'user_token' }
                : null,
          ),
      ),
  } as unknown as jest.Mocked<QaUatHeadsService>;
  const github = {
    findOpenPullRequest: jest
      .fn()
      .mockResolvedValue(
        pullRequest
          ? { number: pullRequest.number, htmlUrl: pullRequest.htmlUrl }
          : null,
      ),
    getPullRequest: jest
      .fn()
      .mockResolvedValue({ headSha: pullRequest?.headSha ?? SHA_API }),
    openPullRequest: jest.fn().mockResolvedValue({
      created: true,
      pullRequest: { number: 7, htmlUrl: 'https://github.com/acme/api/pull/7' },
    }),
    mergePullRequest: jest
      .fn()
      .mockResolvedValue({ merged: true, sha: 'merge-sha', message: 'Merged' }),
  } as unknown as jest.Mocked<GithubProjectPort>;
  const audit = {
    recordProjectEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AuditEventPublisher>;
  const notifications = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<NotificationEventPublisher>;

  const { service: iterations, repository: iterationRepository } =
    fakeIterations();
  const service = new QaPromotionService(
    access,
    projectContext,
    requirements,
    projectRuns,
    headsService,
    iterations,
    github,
    audit,
    notifications,
  );
  return {
    service,
    access,
    github,
    audit,
    notifications,
    headsService,
    requirements,
    projectRuns,
    iterationRepository,
  };
}

describe('QaPromotionService.getStatus (per-Project gate)', () => {
  it('is eligible when the latest signed-off run is Approved and current for every repository', async () => {
    const { service } = setup();

    const status = await service.getStatus('p-api', actor);

    expect(status).toMatchObject({
      scope: 'project',
      deliveryProject: { id: 'dp-1', name: 'Checkout' },
      eligible: true,
      reasons: [],
      headSha: SHA_API,
      canMerge: true,
      requirementsChanged: false,
      run: { id: 'run-1', verdict: 'APPROVED', stale: false },
    });
    expect(status.repositories).toHaveLength(2);
    // Deprecated per-requirement entries carry the Project-level result.
    expect(status.checklists).toEqual([
      expect.objectContaining({ name: 'Requirement 0', approvedForHead: true }),
      expect.objectContaining({ name: 'Requirement 1', approvedForHead: true }),
    ]);
  });

  it('gates on the requirements and the sign-off of the current Iteration only', async () => {
    const { service, requirements, projectRuns, iterationRepository } = setup();
    iterationRepository.findCurrent.mockResolvedValue(
      iterationRow({ id: 'it-4', number: 4 }),
    );

    await service.getStatus('p-api', actor);

    expect(requirements.listActiveByIteration).toHaveBeenCalledWith('it-4');
    expect(projectRuns.findLatestSignedOff).toHaveBeenCalledWith('it-4');
    expect(requirements.requirementsChangedSince).toHaveBeenCalledWith(
      'it-4',
      expect.any(String),
    );
  });

  it('blocks this repository when ANOTHER repository of the Project moved', async () => {
    const { service } = setup({
      heads: { 'acme/api': SHA_API, 'acme/web': MOVED },
    });

    const status = await service.getStatus('p-api', actor);

    expect(status.eligible).toBe(false);
    expect(status.run?.stale).toBe(true);
    expect(status.reasons).toEqual([
      'Project run is stale: "web" moved from bbbbbbb to ccccccc',
    ]);
    expect(status.headSha).toBe(SHA_API);
  });

  it('blocks on a Rejected latest sign-off and when a head is unreadable', async () => {
    const rejected = await setup({ verdict: 'REJECTED' }).service.getStatus(
      'p-api',
      actor,
    );
    expect(rejected.eligible).toBe(false);
    expect(rejected.reasons).toEqual(['Latest sign-off is Rejected']);

    const unreadable = await setup({
      heads: { 'acme/api': SHA_API, 'acme/web': null },
    }).service.getStatus('p-api', actor);
    expect(unreadable.eligible).toBe(false);
    expect(unreadable.reasons).toEqual([
      'Could not read the uat head of "web"',
    ]);
  });

  it('blocks with no signed-off run, and with no requirements', async () => {
    const noRun = await setup({ verdict: null, covered: [] }).service.getStatus(
      'p-api',
      actor,
    );
    expect(noRun.run).toBeNull();
    expect(noRun.reasons).toContain('No QA run covers the current uat heads');

    const noRequirements = await setup({
      requirementCount: 0,
    }).service.getStatus('p-api', actor);
    expect(noRequirements.eligible).toBe(false);
    expect(noRequirements.reasons).toEqual([
      'This Project has no QA requirements',
    ]);
  });

  it('blocks a repository filed under no Project', async () => {
    const { service } = setup({ filed: false });

    const status = await service.getStatus('p-api', actor);

    expect(status).toMatchObject({
      scope: 'unfiled',
      deliveryProject: null,
      eligible: false,
      checklists: [],
    });
    expect(status.reasons).toEqual([
      'This repository is not filed under a Project; QA requirements belong to Projects',
    ]);
  });

  it('exposes the open promotion pull request', async () => {
    const { service } = setup({
      pullRequest: { number: 9, htmlUrl: 'https://x/pull/9', headSha: SHA_API },
    });

    const status = await service.getStatus('p-api', actor);

    expect(status.pullRequest).toEqual({
      number: 9,
      url: 'https://x/pull/9',
      headSha: SHA_API,
    });
  });

  it('404s a repository the caller cannot see', async () => {
    const { service, access } = setup();
    access.findVisibleProject.mockResolvedValue(null);

    await expect(service.getStatus('p-api', actor)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('QaPromotionService.merge', () => {
  it('forbids a caller who is not lead|admin', async () => {
    const { service, github } = setup({ role: 'qa' });

    await expect(service.merge('p-api', actor)).rejects.toThrow(
      ForbiddenException,
    );
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('409 QA_PROJECT_REQUIRED for an unfiled repository', async () => {
    const { service, github } = setup({ filed: false });

    await expect(service.merge('p-api', actor)).rejects.toMatchObject({
      response: { code: 'QA_PROJECT_REQUIRED' },
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('409 QA_PROMOTION_BLOCKED with reasons when the gate is closed', async () => {
    const { service, github } = setup({
      heads: { 'acme/api': SHA_API, 'acme/web': MOVED },
    });

    await expect(service.merge('p-api', actor)).rejects.toMatchObject({
      response: {
        code: 'QA_PROMOTION_BLOCKED',
        reasons: expect.any(Array) as string[],
      },
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('opens the promotion PR listing the run and its repositories, merges at the checked sha, audits and notifies the other leads', async () => {
    const { service, github, audit, notifications } = setup();

    const result = await service.merge('p-api', actor);

    expect(result).toEqual({
      merged: true,
      sha: 'merge-sha',
      message: 'Merged',
      pullRequest: { number: 7, url: 'https://github.com/acme/api/pull/7' },
    });
    const body = (github.openPullRequest.mock.calls[0]?.[2] as { body: string })
      .body;
    expect(body).toContain('Project run run-1 covered:');
    expect(body).toContain('`acme/web` @ bbbbbbb');
    // The App installation token, never the lead's own (read-only) token.
    expect(github.openPullRequest).toHaveBeenCalledWith(
      'app-token',
      'acme/api',
      expect.any(Object),
    );
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      'app-token',
      'acme/api',
      7,
      { method: 'merge', sha: SHA_API },
    );
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'qa.promotion.merged',
        actorUserId: 'lead-1',
        metadata: expect.objectContaining({
          deliveryProjectId: 'dp-1',
          runId: 'run-1',
          via: 'github_app',
        }) as Record<string, unknown>,
      }),
    );
    expect(notifications.record).toHaveBeenCalledTimes(1);
    expect(notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'lead-2' }),
    );
  });

  it('409 QA_UAT_MOVED when the pull request head is not the checked head', async () => {
    const { service } = setup({
      pullRequest: { number: 9, htmlUrl: 'https://x/pull/9', headSha: MOVED },
    });

    await expect(service.merge('p-api', actor)).rejects.toMatchObject({
      response: { code: 'QA_UAT_MOVED' },
    });
  });

  it('409 GITHUB_REAUTH only when neither an installation nor a session token exists', async () => {
    const { service, github } = setup({ installationToken: null });

    await expect(
      service.merge('p-api', { ...actor, oauthToken: null }),
    ).rejects.toMatchObject({ response: { code: 'GITHUB_REAUTH' } });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('merges with the App for a caller with no session token', async () => {
    const { service, github } = setup();

    const result = await service.merge('p-api', { ...actor, oauthToken: null });

    expect(result.merged).toBe(true);
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      'app-token',
      'acme/api',
      7,
      expect.any(Object),
    );
  });

  it('falls back to the caller token when no installation resolves, and audits via user_token', async () => {
    const { service, github, audit } = setup({ installationToken: null });

    await service.merge('p-api', actor);

    expect(github.mergePullRequest).toHaveBeenCalledWith(
      'gho_token',
      'acme/api',
      7,
      expect.any(Object),
    );
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ via: 'user_token' }) as Record<
          string,
          unknown
        >,
      }),
    );
  });

  it('keeps the gate when the latest run is not Approved: no GitHub write', async () => {
    const { service, github, headsService } = setup({
      heads: { 'acme/api': SHA_API, 'acme/web': MOVED },
    });

    await expect(service.merge('p-api', actor)).rejects.toMatchObject({
      response: { code: 'QA_PROMOTION_BLOCKED' },
    });
    expect(headsService.resolveWriteCredential).not.toHaveBeenCalled();
    expect(github.openPullRequest).not.toHaveBeenCalled();
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('returns merged:false with GitHub text when GitHub refuses', async () => {
    const { service, github } = setup();
    github.mergePullRequest.mockResolvedValue({
      merged: false,
      sha: null,
      message: 'Required status check missing',
    } as never);

    const result = await service.merge('p-api', actor);

    expect(result).toMatchObject({
      merged: false,
      message: 'Required status check missing',
    });
  });
});

describe('end to end: two repositories, one Project', () => {
  it('approve, merge A, B moves, A is blocked; after a new approval both are eligible', async () => {
    // Merging A leaves uat untouched, so B stays eligible while nothing moved.
    const approved = setup();
    expect((await approved.service.getStatus('p-api', actor)).eligible).toBe(
      true,
    );
    await approved.service.merge('p-api', actor);
    expect((await approved.service.getStatus('p-api', actor)).eligible).toBe(
      true,
    );

    // B's uat moves: A is blocked too.
    const moved = setup({ heads: { 'acme/api': SHA_API, 'acme/web': MOVED } });
    expect((await moved.service.getStatus('p-api', actor)).eligible).toBe(
      false,
    );

    // A new run on the new heads, approved: both eligible again.
    const reapproved = setup({
      heads: { 'acme/api': SHA_API, 'acme/web': MOVED },
      covered: [
        { project_id: 'p-api', head_sha: SHA_API },
        { project_id: 'p-web', head_sha: MOVED },
      ],
    });
    expect((await reapproved.service.getStatus('p-api', actor)).eligible).toBe(
      true,
    );
  });
});
