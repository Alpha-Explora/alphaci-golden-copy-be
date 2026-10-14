import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { GithubProjectPort } from '#kernel/ports/github.port';
import {
  deliveredIterationRow,
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
import { QaProjectDeliveryService } from './qa-project-delivery.service';
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
  mainRelation = {},
  projectRepositories = [API, WEB],
  iteration = iterationRow(),
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
  /** What GitHub says for compare/{uatHead}...main, per repository. Default: main is behind (not contained). */
  mainRelation?: Record<
    string,
    'ahead' | 'behind' | 'diverged' | 'identical' | null
  >;
  projectRepositories?: Array<{
    projectId: string;
    name: string;
    repoFullName: string;
  }>;
  iteration?: ReturnType<typeof iterationRow>;
} = {}) {
  const rows: Record<string, unknown> = {
    'p-api': {
      id: 'p-api',
      repo_full_name: 'acme/api',
      service_name: 'api',
      workspace_id: 'group-1',
    },
    'p-web': {
      id: 'p-web',
      repo_full_name: 'acme/web',
      service_name: 'web',
      workspace_id: 'group-1',
    },
  };
  const access = {
    findVisibleProject: jest
      .fn()
      .mockImplementation((id: string) => Promise.resolve(rows[id] ?? null)),
    findAppRole: jest.fn().mockResolvedValue(role),
    listWorkspaceLeadIds: jest.fn().mockResolvedValue(['lead-1', 'lead-2']),
    listWorkspaceLeadAndDeveloperIds: jest
      .fn()
      .mockResolvedValue(['lead-1', 'lead-2', 'dev-1']),
    listWorkspaceQaIds: jest.fn().mockResolvedValue(['qa-1']),
    canManage: jest.fn().mockResolvedValue(role === 'lead' || role === 'admin'),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    findProjectOfRepository: jest
      .fn()
      .mockResolvedValue(filed ? folder() : null),
    requireProject: jest
      .fn()
      .mockResolvedValue({ ...folder(), repositories: projectRepositories }),
    anchorProjectId: jest.fn().mockResolvedValue('p-api'),
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
            repositories: covered.map((row) => ({
              run_id: 'run-1',
              repo_full_name:
                row.project_id === 'p-api' ? 'acme/api' : 'acme/web',
              ...row,
            })),
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
      .mockImplementation((_token: string, repo: string) =>
        Promise.resolve({
          headSha:
            repo === 'acme/web' ? SHA_WEB : (pullRequest?.headSha ?? SHA_API),
        }),
      ),
    openPullRequest: jest.fn().mockResolvedValue({
      created: true,
      pullRequest: { number: 7, htmlUrl: 'https://github.com/acme/api/pull/7' },
    }),
    mergePullRequest: jest
      .fn()
      .mockResolvedValue({ merged: true, sha: 'merge-sha', message: 'Merged' }),
    getBranchRelation: jest
      .fn()
      .mockImplementation((_token: string, repo: string) =>
        Promise.resolve(mainRelation[repo] ?? 'behind'),
      ),
  } as unknown as jest.Mocked<GithubProjectPort>;
  const audit = {
    recordProjectEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AuditEventPublisher>;
  const notifications = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<NotificationEventPublisher>;

  const {
    service: iterations,
    repository: iterationRepository,
    state: iterationState,
  } = fakeIterations(iteration);
  const delivery = new QaProjectDeliveryService(
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
  const service = new QaPromotionService(
    access,
    projectContext,
    requirements,
    headsService,
    iterations,
    delivery,
    github,
    audit,
    notifications,
  );
  return {
    service,
    delivery,
    iterationState,
    projectContext,
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

const stored = (
  projectId: string,
  repoFullName: string,
  sha: string,
  how: 'merged' | 'already_in_main' = 'merged',
) => ({
  projectId,
  repoFullName,
  uatHeadSha: sha,
  mergeSha: how === 'merged' ? 'm'.repeat(40) : null,
  prNumber: how === 'merged' ? 3 : null,
  how,
  at: '2026-10-14T00:00:00.000Z',
});

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
      how: 'merged',
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

const DELIVERED_EVENT = 'qa.iteration.delivered';

describe('Merge to main: delivery of the Iteration', () => {
  it('compares the signed-off uat head against main: base = the head, head = main', async () => {
    const { service, github } = setup();

    await service.merge('p-api', actor);

    // GitHub reports the status of the HEAD (main) relative to the BASE (the
    // uat sha): "ahead" or "identical" means main contains the sha.
    expect(github.getBranchRelation).toHaveBeenCalledWith(
      'app-token',
      'acme/api',
      SHA_API,
      'main',
    );
  });

  it.each([
    ['ahead', true],
    ['identical', true],
    ['behind', false],
    ['diverged', false],
    [null, false],
  ] as const)(
    'main relation %s means "already in main" = %s',
    async (relation, contained) => {
      const { service, github } = setup({
        mainRelation: { 'acme/api': relation },
      });

      const result = await service.merge('p-api', actor);

      expect(github.openPullRequest).toHaveBeenCalledTimes(contained ? 0 : 1);
      expect(result.message === 'main already contains this commit').toBe(
        contained,
      );
    },
  );

  it('already in main: merged:false with a clear message, never an error, recorded as already_in_main', async () => {
    const { service, github, iterationState, audit } = setup({
      mainRelation: { 'acme/api': 'ahead' },
    });

    const result = await service.merge('p-api', actor);

    expect(result).toEqual({
      merged: false,
      sha: null,
      message: 'main already contains this commit',
      pullRequest: null,
      how: 'already_in_main',
    });
    expect(github.openPullRequest).not.toHaveBeenCalled();
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(iterationState.row.delivery_json).toEqual({
      repositories: [
        expect.objectContaining({
          projectId: 'p-api',
          uatHeadSha: SHA_API,
          mergeSha: null,
          prNumber: null,
          how: 'already_in_main',
        }),
      ],
    });
    // One of two repositories: not delivered, no iteration event yet.
    expect(iterationState.row.status).toBe('active');
    expect(audit.recordProjectEvent).not.toHaveBeenCalled();
  });

  it('a successful merge records mergeSha and prNumber, then the status shows the repository delivered (survives a reload)', async () => {
    const { service, iterationState } = setup();

    await service.merge('p-api', actor);

    expect(iterationState.row.delivery_json).toEqual({
      repositories: [
        expect.objectContaining({
          projectId: 'p-api',
          repoFullName: 'acme/api',
          uatHeadSha: SHA_API,
          mergeSha: 'merge-sha',
          prNumber: 7,
          how: 'merged',
        }),
      ],
    });
    const status = await service.getStatus('p-api', actor);
    expect(status).toMatchObject({
      repositoryDelivered: true,
      iterationDelivered: false,
      iteration: { number: 1, status: 'active', deliveredAt: null },
      reasonCodes: [],
    });
    // The other repository is not.
    expect(await setup().service.getStatus('p-api', actor)).toMatchObject({
      repositoryDelivered: false,
    });
  });

  it('an entry for an OLDER head does not count as delivered', async () => {
    const { service } = setup({
      iteration: iterationRow({
        delivery_json: {
          repositories: [stored('p-api', 'acme/api', 'd'.repeat(40))],
        },
      }),
    });

    expect((await service.getStatus('p-api', actor)).repositoryDelivered).toBe(
      false,
    );
  });

  it('the last repository delivers the Iteration once: audit event and notifications to leads, developers and QA, not the actor', async () => {
    const { service, iterationState, audit, notifications } = setup({
      iteration: iterationRow({
        delivery_json: {
          repositories: [stored('p-web', 'acme/web', SHA_WEB)],
        },
      }),
    });

    await service.merge('p-api', actor);

    expect(iterationState.row).toMatchObject({
      status: 'delivered',
      delivered_by: 'lead-1',
      delivered_by_login: 'lead',
      signoff_run_id: 'run-1',
    });
    const events = audit.recordProjectEvent.mock.calls.filter(
      ([input]) => input.eventCode === DELIVERED_EVENT,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.[0]).toMatchObject({
      workspaceId: 'group-1',
      projectId: 'p-api',
      actorUserId: 'lead-1',
      metadata: {
        deliveryProjectId: 'dp-1',
        iterationId: 'it-1',
        number: 1,
        signoffRunId: 'run-1',
        repositories: [
          expect.objectContaining({ repoFullName: 'acme/api', how: 'merged' }),
          expect.objectContaining({ repoFullName: 'acme/web', how: 'merged' }),
        ],
      },
    });
    const delivered = notifications.record.mock.calls
      .map(([input]) => input)
      .filter((input) => input.eventCode === DELIVERED_EVENT);
    expect(delivered.map((input) => input.userId).sort()).toEqual([
      'dev-1',
      'lead-2',
      'qa-1',
    ]);
    expect(delivered[0]).toMatchObject({
      title: 'Iteration 1 of Checkout was delivered',
      projectId: 'p-api',
    });
    expect(delivered[0]?.body).toContain('acme/api');
    expect(delivered[0]?.body).toContain('acme/web');
  });

  it('merging one repository also notices that the other already has the head in main, and delivers', async () => {
    const { service, iterationState } = setup({
      mainRelation: { 'acme/web': 'ahead' },
    });

    await service.merge('p-api', actor);

    expect(iterationState.row.status).toBe('delivered');
    expect(iterationState.row.delivery_json).toEqual({
      repositories: [
        expect.objectContaining({ repoFullName: 'acme/api', how: 'merged' }),
        expect.objectContaining({
          repoFullName: 'acme/web',
          how: 'already_in_main',
        }),
      ],
    });
  });

  it('a double click on the final merge delivers and announces exactly once', async () => {
    const { service, audit, notifications, iterationState } = setup({
      mainRelation: { 'acme/web': 'identical' },
    });

    await Promise.all([
      service.merge('p-api', actor),
      service.merge('p-api', actor),
    ]);

    expect(iterationState.row.status).toBe('delivered');
    expect(
      audit.recordProjectEvent.mock.calls.filter(
        ([input]) => input.eventCode === DELIVERED_EVENT,
      ),
    ).toHaveLength(1);
    expect(
      notifications.record.mock.calls.filter(
        ([input]) => input.eventCode === DELIVERED_EVENT,
      ),
    ).toHaveLength(3);
  });

  it('refuses Merge on a delivered Iteration with 409 ITERATION_DELIVERED and no GitHub call', async () => {
    const { service, github, headsService } = setup({
      iteration: deliveredIterationRow({
        number: 2,
        delivery_json: {
          repositories: [
            stored('p-api', 'acme/api', SHA_API),
            stored('p-web', 'acme/web', SHA_WEB),
          ],
        },
      }),
    });

    await expect(service.merge('p-api', actor)).rejects.toMatchObject({
      response: { code: 'ITERATION_DELIVERED', iterationNumber: 2 },
    });
    expect(headsService.resolveWriteCredential).not.toHaveBeenCalled();
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('the gate on a delivered Iteration is eligible:false with reason code ITERATION_DELIVERED', async () => {
    const { service } = setup({
      iteration: deliveredIterationRow({
        number: 2,
        delivery_json: {
          repositories: [stored('p-api', 'acme/api', SHA_API)],
        },
      }),
    });

    const status = await service.getStatus('p-api', actor);

    expect(status).toMatchObject({
      eligible: false,
      iterationDelivered: true,
      repositoryDelivered: true,
      reasonCodes: ['ITERATION_DELIVERED'],
      iteration: {
        id: 'it-1',
        number: 2,
        status: 'delivered',
        deliveredAt: '2026-10-10T00:00:00.000Z',
      },
    });
    expect(status.reasons[0]).toBe(
      'Iteration 2 was delivered. Start the next iteration to merge again.',
    );
  });
});

describe('QaPromotionService.mergeAll', () => {
  const MERGE_ALL = 'dp-1';

  it('merges every covered repository in a stable order, delivers, and answers with the per-repository results', async () => {
    const { service, github, iterationState, audit } = setup();

    const result = await service.mergeAll(MERGE_ALL, actor);

    expect(github.mergePullRequest.mock.calls.map((call) => call[1])).toEqual([
      'acme/api',
      'acme/web',
    ]);
    expect(result).toEqual({
      repositories: [
        {
          projectId: 'p-api',
          repoFullName: 'acme/api',
          merged: true,
          how: 'merged',
          message: null,
        },
        {
          projectId: 'p-web',
          repoFullName: 'acme/web',
          merged: true,
          how: 'merged',
          message: null,
        },
      ],
      delivered: true,
      iteration: expect.objectContaining({
        id: 'it-1',
        number: 1,
        status: 'delivered',
        deliveredAt: '2026-10-15T00:00:00.000Z',
        signoffRunId: 'run-1',
      }) as unknown,
    });
    expect(iterationState.row.status).toBe('delivered');
    expect(
      audit.recordProjectEvent.mock.calls.filter(
        ([input]) => input.eventCode === DELIVERED_EVENT,
      ),
    ).toHaveLength(1);
  });

  it('reports a repository whose main already has the head as already_in_main (merged:false)', async () => {
    const { service, github } = setup({
      mainRelation: { 'acme/web': 'ahead' },
    });

    const result = await service.mergeAll(MERGE_ALL, actor);

    expect(result.repositories[1]).toEqual({
      projectId: 'p-web',
      repoFullName: 'acme/web',
      merged: false,
      how: 'already_in_main',
      message: 'main already contains this commit',
    });
    expect(result.delivered).toBe(true);
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('a partial failure keeps going and leaves the Iteration active; a retry merges only what remains', async () => {
    const { service, github, iterationState, audit } = setup();
    github.mergePullRequest
      .mockResolvedValueOnce({
        merged: true,
        sha: 'merge-api',
        message: 'Merged',
      } as never)
      .mockResolvedValueOnce({
        merged: false,
        sha: null,
        message: 'Required status check missing',
      } as never);

    const first = await service.mergeAll(MERGE_ALL, actor);

    expect(first.delivered).toBe(false);
    expect(first.iteration.status).toBe('active');
    expect(first.repositories).toEqual([
      expect.objectContaining({ repoFullName: 'acme/api', merged: true }),
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        merged: false,
        how: null,
        message: 'Required status check missing',
      },
    ]);
    // api is stored already, web is not.
    expect(iterationState.row.delivery_json).toEqual({
      repositories: [expect.objectContaining({ projectId: 'p-api' })],
    });
    expect(audit.recordProjectEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: DELIVERED_EVENT }),
    );

    github.mergePullRequest.mockResolvedValue({
      merged: true,
      sha: 'merge-web',
      message: 'Merged',
    } as never);
    const retry = await service.mergeAll(MERGE_ALL, actor);

    expect(retry.delivered).toBe(true);
    expect(retry.repositories).toEqual([
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        merged: false,
        how: 'merged',
        message: 'Already delivered earlier.',
      },
      expect.objectContaining({
        repoFullName: 'acme/web',
        merged: true,
        how: 'merged',
      }),
    ]);
    // api was merged exactly once across both calls.
    expect(
      github.mergePullRequest.mock.calls.filter(
        (call) => call[1] === 'acme/api',
      ),
    ).toHaveLength(1);
  });

  it('one repository throwing (uat moved) does not stop the others', async () => {
    const { service, github } = setup();
    github.getPullRequest.mockResolvedValueOnce({ headSha: MOVED } as never);

    const result = await service.mergeAll(MERGE_ALL, actor);

    expect(result.repositories[0]).toMatchObject({
      repoFullName: 'acme/api',
      merged: false,
      how: null,
      message: expect.stringContaining('uat moved') as string,
    });
    expect(result.repositories[1]).toMatchObject({
      repoFullName: 'acme/web',
      merged: true,
    });
    expect(result.delivered).toBe(false);
  });

  it('two concurrent merge-alls deliver once: one audit event, one set of notifications', async () => {
    const { service, audit, notifications, iterationRepository } = setup();

    const [a, b] = await Promise.all([
      service.mergeAll(MERGE_ALL, actor),
      service.mergeAll(MERGE_ALL, actor),
    ]);

    expect(a.delivered).toBe(true);
    expect(b.delivered).toBe(true);
    // Both reached the transition; only one UPDATE changed the row.
    const results = await Promise.all(
      iterationRepository.markDelivered.mock.results.map(
        (r) => r.value as Promise<unknown>,
      ),
    );
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(
      audit.recordProjectEvent.mock.calls.filter(
        ([input]) => input.eventCode === DELIVERED_EVENT,
      ),
    ).toHaveLength(1);
    expect(
      notifications.record.mock.calls.filter(
        ([input]) => input.eventCode === DELIVERED_EVENT,
      ),
    ).toHaveLength(3);
  });

  it('403 for a caller who is not lead|admin', async () => {
    const { service, github } = setup({ role: 'qa' });

    await expect(service.mergeAll(MERGE_ALL, actor)).rejects.toThrow(
      ForbiddenException,
    );
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('409 ITERATION_DELIVERED on a delivered Iteration', async () => {
    const { service, github } = setup({
      iteration: deliveredIterationRow({ number: 3 }),
    });

    await expect(service.mergeAll(MERGE_ALL, actor)).rejects.toMatchObject({
      response: { code: 'ITERATION_DELIVERED', iterationNumber: 3 },
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('409 QA_PROMOTION_BLOCKED with the gate reasons (rejected, stale, no requirements)', async () => {
    const rejected = setup({ verdict: 'REJECTED' });
    await expect(
      rejected.service.mergeAll(MERGE_ALL, actor),
    ).rejects.toMatchObject({
      response: {
        code: 'QA_PROMOTION_BLOCKED',
        reasons: ['Latest sign-off is Rejected'],
      },
    });

    const stale = setup({ heads: { 'acme/api': SHA_API, 'acme/web': MOVED } });
    await expect(
      stale.service.mergeAll(MERGE_ALL, actor),
    ).rejects.toMatchObject({ response: { code: 'QA_PROMOTION_BLOCKED' } });

    const none = setup({ requirementCount: 0 });
    await expect(none.service.mergeAll(MERGE_ALL, actor)).rejects.toMatchObject(
      { response: { code: 'QA_PROMOTION_BLOCKED' } },
    );
    expect(rejected.github.mergePullRequest).not.toHaveBeenCalled();
    expect(stale.github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('409 PROJECT_HAS_NO_REPOSITORIES for a Project with no linked repository', async () => {
    const { service } = setup({ projectRepositories: [] });

    await expect(service.mergeAll(MERGE_ALL, actor)).rejects.toMatchObject({
      response: { code: 'PROJECT_HAS_NO_REPOSITORIES' },
    });
  });

  it('404 for a non-member', async () => {
    const { service, projectContext } = setup();
    projectContext.requireProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );

    await expect(service.mergeAll(MERGE_ALL, actor)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('QaProjectDeliveryService.current', () => {
  it('lists the covered repositories with their delivery state and lets a lead Merge all when the gate is eligible', async () => {
    const { delivery } = setup({
      iteration: iterationRow({
        delivery_json: {
          repositories: [stored('p-api', 'acme/api', SHA_API)],
        },
      }),
    });

    const current = await delivery.current('dp-1', actor);

    expect(current.coveredRepositories).toEqual([
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        delivered: true,
        how: 'merged',
      },
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        delivered: false,
        how: null,
      },
    ]);
    expect(current.deliveredRepositories).toHaveLength(1);
    expect(current.canMergeAll).toBe(true);
    expect(current.iteration.status).toBe('active');
  });

  it('canMergeAll is false for a non lead|admin, without reading GitHub heads', async () => {
    const { delivery, headsService } = setup({ role: 'qa' });

    const current = await delivery.current('dp-1', actor);

    expect(current.canMergeAll).toBe(false);
    expect(current.coveredRepositories).toHaveLength(2);
    expect(headsService.readHeads).not.toHaveBeenCalled();
  });

  it('canMergeAll is false when the gate is closed (a head moved)', async () => {
    const { delivery } = setup({
      heads: { 'acme/api': SHA_API, 'acme/web': MOVED },
    });

    expect((await delivery.current('dp-1', actor)).canMergeAll).toBe(false);
  });

  it('no APPROVED sign-off yet: nothing covered and no Merge all', async () => {
    const rejected = setup({ verdict: 'REJECTED' });
    expect(await rejected.delivery.current('dp-1', actor)).toMatchObject({
      coveredRepositories: [],
      canMergeAll: false,
    });

    const none = setup({ verdict: null, covered: [] });
    expect(await none.delivery.current('dp-1', actor)).toMatchObject({
      coveredRepositories: [],
      canMergeAll: false,
    });
  });

  it('a delivered Iteration reports what it stored, and no Merge all', async () => {
    const { delivery } = setup({
      iteration: deliveredIterationRow({
        number: 2,
        delivery_json: {
          repositories: [
            stored('p-api', 'acme/api', SHA_API),
            stored('p-web', 'acme/web', SHA_WEB, 'already_in_main'),
          ],
        },
      }),
    });

    const current = await delivery.current('dp-1', actor);

    expect(current.canMergeAll).toBe(false);
    expect(current.canStartNext).toBe(true);
    expect(current.coveredRepositories).toEqual([
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        delivered: true,
        how: 'merged',
      },
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        delivered: true,
        how: 'already_in_main',
      },
    ]);
    expect(current.deliveredRepositories).toHaveLength(2);
  });

  it('a repository removed from the Project since the sign-off is not a covered repository', async () => {
    const { delivery } = setup({ projectRepositories: [API] });

    const current = await delivery.current('dp-1', actor);

    expect(current.coveredRepositories.map((r) => r.projectId)).toEqual([
      'p-api',
    ]);
  });
});
