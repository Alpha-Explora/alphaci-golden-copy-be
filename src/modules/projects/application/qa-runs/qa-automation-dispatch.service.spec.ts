import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { GithubProjectPort } from '#kernel/ports/github.port';
import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  deliveredIterationRow,
  fakeIterations,
} from '../../__fixtures__/project-iterations';
import type { ProjectIterationRow } from '../../infrastructure/project-iterations.repository';
import type { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import type {
  QaProjectRunRow,
  QaRunRepositoryRow,
} from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type { QaProjectContextService } from '../qa-checklists/qa-project-context.service';
import type { QaUatHeadsService } from './qa-uat-heads.service';
import { QaAutomationDispatchService } from './qa-automation-dispatch.service';

const DP = 'dp-1';
const RUN_ID = 'run-1';
const SHA_API = 'a'.repeat(40);
const SHA_WEB = 'b'.repeat(40);
const MOVED = 'c'.repeat(40);

const actor = { userId: 'user-1', userLogin: 'qa', oauthToken: 'gho_token' };

const runRow = (status: 'open' | 'signed_off' = 'open') =>
  ({
    id: RUN_ID,
    status,
    scope: 'project',
    iteration_id: 'it-1',
  }) as unknown as QaProjectRunRow;

const coverage: QaRunRepositoryRow[] = [
  {
    run_id: RUN_ID,
    project_id: 'p-api',
    repo_full_name: 'acme/api',
    head_sha: SHA_API,
  },
  {
    run_id: RUN_ID,
    project_id: 'p-web',
    repo_full_name: 'acme/web',
    head_sha: SHA_WEB,
  },
];

function setup({
  role = 'qa',
  run = runRow(),
  branchHeads = { 'acme/api': SHA_API, 'acme/web': SHA_WEB },
  dispatchResult = { dispatched: true } as
    | { dispatched: true }
    | { dispatched: false; reason: string; message: string },
  installationToken = 'app-token' as string | null,
  iteration,
}: {
  role?: PlatformAppRole;
  iteration?: ProjectIterationRow;
  run?: QaProjectRunRow | null;
  branchHeads?: Record<string, string>;
  /** The GitHub App installation token; null = no installation resolves. */
  installationToken?: string | null;
  dispatchResult?:
    | { dispatched: true }
    | { dispatched: false; reason: string; message: string };
} = {}) {
  const access = {
    findAppRole: jest.fn().mockResolvedValue(role),
    findVisibleProject: jest.fn().mockImplementation((projectId: string) =>
      Promise.resolve({
        id: projectId,
        workflow_path: '.github/workflows/10-alphaci-ci.yml',
      }),
    ),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    requireProject: jest.fn().mockResolvedValue({
      deliveryProjectId: DP,
      groupId: 'group-1',
      name: 'Checkout',
      repositories: [],
    }),
    anchorProjectId: jest.fn().mockResolvedValue('p-web'),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const projectRuns = {
    findProjectRun: jest.fn().mockResolvedValue(run),
    listCoverageByRunIds: jest
      .fn()
      .mockResolvedValue(new Map([[RUN_ID, coverage]])),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const github = {
    listBranches: jest
      .fn()
      .mockImplementation((_token: string, repo: string) =>
        Promise.resolve([{ name: 'uat', commitSha: branchHeads[repo] }]),
      ),
    dispatchWorkflow: jest.fn().mockResolvedValue(dispatchResult),
  } as unknown as jest.Mocked<GithubProjectPort>;
  const audit = {
    recordProjectEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AuditEventPublisher>;
  const heads = {
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
  const { service: iterations, repository: iterationRepository } =
    fakeIterations(iteration);
  const service = new QaAutomationDispatchService(
    access,
    projectContext,
    projectRuns,
    github,
    heads,
    iterations,
    audit,
  );
  return {
    service,
    access,
    projectRuns,
    github,
    audit,
    heads,
    iterationRepository,
  };
}

describe('QaAutomationDispatchService (Project runs)', () => {
  it('dispatches the verify workflow in every repository the run covers, with the App installation token', async () => {
    const { service, github, audit } = setup();

    const result = await service.dispatch(DP, actor, RUN_ID, {});

    expect(github.dispatchWorkflow).toHaveBeenCalledTimes(2);
    expect(github.dispatchWorkflow).toHaveBeenCalledWith(
      'app-token',
      'acme/api',
      '30-alphaci-verify.yml',
      'uat',
    );
    expect(result.failed).toEqual([]);
    expect(result.dispatched.map((entry) => entry.repoFullName)).toEqual([
      'acme/api',
      'acme/web',
    ]);
    expect(result.dispatched.every((entry) => entry.targetsRunCommit)).toBe(
      true,
    );
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'qa.automation.dispatched',
        projectId: 'p-web',
        workspaceId: 'group-1',
        actorUserId: 'user-1',
        metadata: expect.objectContaining({ via: 'github_app' }) as Record<
          string,
          unknown
        >,
      }),
    );
  });

  it('dispatches with the App for a caller who has no session token', async () => {
    const { service, github } = setup();

    const result = await service.dispatch(
      DP,
      { ...actor, oauthToken: null },
      RUN_ID,
      {},
    );

    expect(result.dispatched).toHaveLength(2);
    expect(github.listBranches).toHaveBeenCalledWith('app-token', 'acme/api');
  });

  it('falls back to the caller token when no installation resolves, and audits via user_token', async () => {
    const { service, github, audit } = setup({ installationToken: null });

    await service.dispatch(DP, actor, RUN_ID, {});

    expect(github.listBranches).toHaveBeenCalledWith('gho_token', 'acme/api');
    expect(github.dispatchWorkflow).toHaveBeenCalledWith(
      'gho_token',
      'acme/api',
      '30-alphaci-verify.yml',
      'uat',
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

  it("names the repository and GitHub's reason when GitHub refuses", async () => {
    const { service } = setup({
      dispatchResult: {
        dispatched: false,
        reason: 'forbidden',
        message: 'Resource not accessible by integration',
      },
    });

    await expect(service.dispatch(DP, actor, RUN_ID, {})).rejects.toMatchObject(
      {
        message:
          'GitHub refused to start the verify workflow in acme/api: Resource not accessible by integration',
      },
    );
  });

  it('narrows to one repository with projectId, and 404s for a repository the run does not cover', async () => {
    const { service, github } = setup();

    const result = await service.dispatch(DP, actor, RUN_ID, {
      projectId: 'p-web',
    });
    expect(github.dispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(result.dispatched[0]?.repoFullName).toBe('acme/web');

    await expect(
      service.dispatch(DP, actor, RUN_ID, { projectId: 'p-other' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('flags a repository whose uat head moved since the run', async () => {
    const { service } = setup({
      branchHeads: { 'acme/api': MOVED, 'acme/web': SHA_WEB },
    });

    const result = await service.dispatch(DP, actor, RUN_ID, {});

    expect(
      result.dispatched.find((entry) => entry.repoFullName === 'acme/api'),
    ).toMatchObject({ targetsRunCommit: false, headSha: MOVED });
  });

  it.each(['member'] as const)('forbids role %s', async (role) => {
    const { service, github } = setup({ role });

    await expect(service.dispatch(DP, actor, RUN_ID, {})).rejects.toThrow(
      ForbiddenException,
    );
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('404s an unknown run and 409s a signed-off one', async () => {
    await expect(
      setup({ run: null }).service.dispatch(DP, actor, RUN_ID, {}),
    ).rejects.toThrow(NotFoundException);
    await expect(
      setup({ run: runRow('signed_off') }).service.dispatch(
        DP,
        actor,
        RUN_ID,
        {},
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('a delivered Iteration refuses a dispatch with 409 ITERATION_DELIVERED, before touching GitHub', async () => {
    const delivered = deliveredIterationRow({ number: 5 });
    const { service, github } = setup({
      iteration: delivered,
      run: { ...runRow('signed_off'), iteration_id: delivered.id },
    });

    await expect(service.dispatch(DP, actor, RUN_ID, {})).rejects.toMatchObject(
      {
        response: {
          code: 'ITERATION_DELIVERED',
          message:
            'Iteration 5 was delivered. Start the next iteration to change this.',
        },
      },
    );
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('409 GITHUB_REAUTH only when neither an installation nor a session token exists, before touching GitHub', async () => {
    const { service, github } = setup({ installationToken: null });

    await expect(
      service.dispatch(DP, { ...actor, oauthToken: null }, RUN_ID, {}),
    ).rejects.toMatchObject({ response: { code: 'GITHUB_REAUTH' } });
    expect(github.listBranches).not.toHaveBeenCalled();
  });

  it('answers the first failure as a coded 409 when nothing could be dispatched', async () => {
    const { service } = setup({
      dispatchResult: {
        dispatched: false,
        reason: 'not_found',
        message: 'missing',
      },
    });

    await expect(service.dispatch(DP, actor, RUN_ID, {})).rejects.toMatchObject(
      { response: { code: 'VERIFY_WORKFLOW_MISSING' } },
    );
  });

  it('reports a partial failure without failing the repositories that worked', async () => {
    const { service, github } = setup();
    github.dispatchWorkflow
      .mockResolvedValueOnce({ dispatched: true })
      .mockResolvedValueOnce({
        dispatched: false,
        reason: 'unauthorized',
        message: 'nope',
      } as never);

    const result = await service.dispatch(DP, actor, RUN_ID, {});

    expect(result.dispatched).toHaveLength(1);
    expect(result.failed).toEqual([
      expect.objectContaining({
        repoFullName: 'acme/web',
        code: 'GITHUB_REAUTH',
      }),
    ]);
  });
});
