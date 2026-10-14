import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import type { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import type { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import {
  QaProgressNotDoneError,
  type QaProjectRunRow,
  type QaRunItemRow,
  type QaRunRepositoryRow,
  type QaRunSignoffRow,
  type QaRunsRepository,
} from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type {
  QaProjectContext,
  QaProjectContextService,
} from '../qa-checklists/qa-project-context.service';
import type { QaRequirementsService } from '../qa-checklists/qa-requirements.service';
import type { QaAutomationService } from './qa-automation.service';
import type { QaRunAttachmentsService } from './qa-run-attachments.service';
import type { ProjectQaRun } from './qa-runs.contracts';
import {
  QaProjectRunsService,
  buildHeadStatuses,
} from './qa-project-runs.service';
import {
  fingerprintHeads,
  type QaUatHeadsService,
} from './qa-uat-heads.service';

const DP = 'dp-1';
const SHA_API = 'a'.repeat(40);
const SHA_WEB = 'b'.repeat(40);
const MOVED = 'c'.repeat(40);
const API = { projectId: 'p-api', name: 'api', repoFullName: 'acme/api' };
const WEB = { projectId: 'p-web', name: 'web', repoFullName: 'acme/web' };

const project: QaProjectContext = {
  deliveryProjectId: DP,
  groupId: 'group-1',
  name: 'Checkout',
  repositories: [API, WEB],
};

const actor = (userId = 'qa-1') => ({
  userId,
  userLogin: 'qa',
  oauthToken: 'tok',
});

const runRow = (overrides: Partial<QaProjectRunRow> = {}): QaProjectRunRow => ({
  id: 'run-1',
  scope: 'project',
  project_id: null,
  commit_sha: null,
  delivery_project_id: DP,
  heads_fingerprint: 'f'.repeat(64),
  checklist_id: null,
  checklist_version: 0,
  checklist_name: 'Checkout',
  branch: 'uat',
  commit_source: 'branch_head',
  status: 'open',
  created_by: 'qa-1',
  created_by_login: 'qa',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const itemRow = (overrides: Partial<QaRunItemRow> = {}): QaRunItemRow => ({
  id: 'ri-1',
  run_id: 'run-1',
  source_item_id: 'item-1',
  prior_run_item_id: null,
  position: 0,
  title: 'Pay by card',
  description: null,
  target_persona: 'all',
  verification_type: 'manual',
  test_identifier: null,
  status: 'pending',
  notes: null,
  defect_severity: null,
  reproduction_steps: null,
  fix_requested_at: null,
  fix_requested_by: null,
  fix_requested_by_login: null,
  fix_note: null,
  verified_by: null,
  verified_by_login: null,
  verified_at: null,
  row_version: 1,
  updated_at: '2026-10-01T00:00:00.000Z',
  requirement_id: 'req-1',
  requirement_name: 'Checkout',
  requirement_kind: 'functional',
  acceptance_criteria: 'Receipt shown',
  ...overrides,
});

const coverage: QaRunRepositoryRow[] = [
  {
    run_id: 'run-1',
    project_id: 'p-api',
    repo_full_name: 'acme/api',
    head_sha: SHA_API,
  },
  {
    run_id: 'run-1',
    project_id: 'p-web',
    repo_full_name: 'acme/web',
    head_sha: SHA_WEB,
  },
];

const reading = (repository: typeof API, sha: string | null) =>
  sha
    ? ({ kind: 'ok', repository, sha } as const)
    : ({ kind: 'unreadable', repository } as const);

function setup({
  role = 'qa',
  readings = [reading(API, SHA_API), reading(WEB, SHA_WEB)],
  items = [itemRow()],
  run = runRow(),
}: {
  role?: PlatformAppRole;
  readings?:
    | ReturnType<typeof reading>[]
    | Array<{ kind: 'branch_missing'; repository: typeof API }>;
  items?: QaRunItemRow[];
  run?: QaProjectRunRow | null;
} = {}) {
  const runs = {
    listItemsByRunId: jest.fn().mockResolvedValue(items),
    listItemsByRunIds: jest.fn().mockResolvedValue(new Map()),
    findActiveSignoff: jest.fn().mockResolvedValue(null),
    findActiveSignoffsByRunIds: jest.fn().mockResolvedValue(new Map()),
    findItemForRun: jest.fn().mockResolvedValue(items[0] ?? null),
    findPriorItemSummaries: jest.fn().mockResolvedValue(new Map()),
    updateItem: jest.fn(),
    createSignoff: jest.fn(),
    reopenRun: jest.fn(),
    listSupersededSignoffs: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<QaRunsRepository>;
  const projectRuns = {
    findProjectRun: jest.fn().mockResolvedValue(run),
    findRunByFingerprint: jest.fn().mockResolvedValue(null),
    findNewestProjectRun: jest.fn().mockResolvedValue(null),
    listCoverageByRunIds: jest
      .fn()
      .mockResolvedValue(new Map([['run-1', coverage]])),
    listProjectRuns: jest.fn().mockResolvedValue([]),
    createRun: jest.fn(),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const checklists = {
    listItemsByChecklistIds: jest.fn().mockResolvedValue(
      new Map([
        [
          'req-1',
          [
            {
              id: 'item-1',
              title: 'Pay by card',
              description: null,
              verification_type: 'manual',
              test_identifier: null,
              acceptance_criteria: 'Receipt shown',
              progress: 'done',
              position: 0,
            },
            {
              id: 'item-2',
              title: 'Pay by wallet',
              description: null,
              verification_type: 'manual',
              test_identifier: null,
              acceptance_criteria: null,
              progress: 'todo',
              position: 1,
            },
          ],
        ],
        [
          'req-2',
          [
            {
              id: 'item-3',
              title: 'Health endpoint',
              description: null,
              verification_type: 'manual',
              test_identifier: null,
              acceptance_criteria: null,
              progress: 'in_progress',
              position: 0,
            },
          ],
        ],
      ]),
    ),
  } as unknown as jest.Mocked<QaChecklistsRepository>;
  const requirements = {
    listActiveByDeliveryProject: jest.fn().mockResolvedValue([
      { id: 'req-1', name: 'Checkout', kind: 'functional' },
      { id: 'req-2', name: 'API checks', kind: 'system' },
    ]),
    listItemsByIds: jest
      .fn()
      .mockResolvedValue(
        new Map([['item-1', { id: 'item-1', progress: 'done' }]]),
      ),
    requirementsChangedSince: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<QaRequirementsRepository>;
  const requirementsService = {
    toItem: jest
      .fn()
      .mockImplementation((item: { id: string; progress: string }) => ({
        id: item.id,
        progress: item.progress,
      })),
  } as unknown as jest.Mocked<QaRequirementsService>;
  const access = {
    findAppRole: jest.fn().mockResolvedValue(role),
    findProjectOwnerId: jest.fn().mockResolvedValue('owner-1'),
    listWorkspaceLeadIds: jest.fn().mockResolvedValue(['lead-1', 'qa-1']),
    listWorkspaceLeadAndDeveloperIds: jest
      .fn()
      .mockResolvedValue(['lead-1', 'dev-1', 'qa-1']),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    requireProject: jest.fn().mockResolvedValue(project),
    anchorProjectId: jest.fn().mockResolvedValue('p-web'),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const heads = {
    readHeads: jest.fn().mockResolvedValue(readings),
  } as unknown as jest.Mocked<QaUatHeadsService>;
  const automation = {
    forRun: jest.fn().mockResolvedValue({ verify: null, quality: null }),
  } as unknown as jest.Mocked<QaAutomationService>;
  const attachments = {
    countsByItem: jest.fn().mockResolvedValue(new Map<string, number>()),
    fixProofCountsByItem: jest
      .fn()
      .mockResolvedValue(new Map<string, number>()),
    referencesForRun: jest.fn().mockResolvedValue(new Map()),
    isEnabled: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<QaRunAttachmentsService>;
  const audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };
  const notifications = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new QaProjectRunsService(
    runs,
    projectRuns,
    checklists,
    requirements,
    requirementsService,
    access,
    projectContext,
    heads,
    automation,
    attachments,
    audit,
    notifications,
  );
  return {
    service,
    attachments,
    runs,
    projectRuns,
    checklists,
    requirements,
    access,
    projectContext,
    heads,
    audit,
    notifications,
  };
}

describe('buildHeadStatuses', () => {
  it('pairs captured and current heads; a repository the run lacks counts as moved', () => {
    const statuses = buildHeadStatuses(
      [API, WEB],
      [reading(API, SHA_API), reading(WEB, MOVED)],
      [coverage[0]!],
    );

    expect(statuses).toEqual([
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        runSha: SHA_API,
        currentSha: SHA_API,
        moved: false,
      },
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        runSha: null,
        currentSha: MOVED,
        moved: true,
      },
    ]);
  });

  it('nothing is moved without a run to compare, and an unreadable head never counts as moved', () => {
    expect(
      buildHeadStatuses([API], [reading(API, SHA_API)], null)[0]?.moved,
    ).toBe(false);
    expect(
      buildHeadStatuses([API], [reading(API, null)], coverage)[0],
    ).toMatchObject({ currentSha: null, moved: false });
  });
});

describe('QaProjectRunsService.create', () => {
  const createdResult = () => ({
    created: true,
    run: runRow(),
    items: [itemRow()],
    repositories: coverage,
  });

  it('snapshots every requirement in order with global positions and a fingerprint of the heads', async () => {
    const { service, projectRuns, audit } = setup();
    projectRuns.createRun.mockResolvedValue(createdResult());

    const result = await service.create(DP, actor());

    expect(result.created).toBe(true);
    const input = projectRuns.createRun.mock.calls[0]![0];
    expect(input.headsFingerprint).toBe(
      fingerprintHeads([
        { projectId: 'p-api', headSha: SHA_API },
        { projectId: 'p-web', headSha: SHA_WEB },
      ]),
    );
    expect(input.repositories.map((repo) => repo.headSha)).toEqual([
      SHA_API,
      SHA_WEB,
    ]);
    expect(
      input.items.map((item) => [
        item.requirementName,
        item.title,
        item.position,
      ]),
    ).toEqual([
      ['Checkout', 'Pay by card', 0],
      ['Checkout', 'Pay by wallet', 1],
      ['API checks', 'Health endpoint', 2],
    ]);
    expect(input.items[0]).toMatchObject({
      requirementKind: 'functional',
      acceptanceCriteria: 'Receipt shown',
    });
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'qa.run.created',
        projectId: 'p-web',
      }),
    );
    expect(result.run.repositories).toHaveLength(2);
    expect(result.run.items[0]).toMatchObject({
      requirementName: 'Checkout',
      progress: 'done',
      sourceItemId: 'item-1',
    });
  });

  it('is idempotent for the same heads: created false, no second audit event', async () => {
    const { service, projectRuns, audit } = setup();
    projectRuns.createRun.mockResolvedValue({
      ...createdResult(),
      created: false,
    });

    const result = await service.create(DP, actor());

    expect(result.created).toBe(false);
    expect(audit.recordProjectEvent).not.toHaveBeenCalled();
  });

  it('a developer cannot start a run', async () => {
    const { service, projectRuns } = setup({ role: 'member' });

    await expect(service.create(DP, actor('dev-1'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(projectRuns.createRun).not.toHaveBeenCalled();
  });

  it('QA_NO_REQUIREMENTS when there is nothing to verify', async () => {
    const { service, requirements } = setup();
    requirements.listActiveByDeliveryProject.mockResolvedValue([]);

    await expect(service.create(DP, actor())).rejects.toMatchObject({
      response: { code: 'QA_NO_REQUIREMENTS' },
    });
  });

  it('QA_UAT_HEAD_UNREADABLE lists the repositories, before QA_UAT_BRANCH_MISSING', async () => {
    const { service, projectRuns } = setup({
      readings: [reading(API, SHA_API), reading(WEB, null)],
    });

    await expect(service.create(DP, actor())).rejects.toMatchObject({
      response: {
        code: 'QA_UAT_HEAD_UNREADABLE',
        reasons: ['Could not read the uat head of "acme/web"'],
      },
    });
    expect(projectRuns.createRun).not.toHaveBeenCalled();

    const missing = setup({
      readings: [{ kind: 'branch_missing', repository: API }],
    });
    await expect(missing.service.create(DP, actor())).rejects.toMatchObject({
      response: { code: 'QA_UAT_BRANCH_MISSING' },
    });
  });

  it('QA_NO_REPOSITORIES for a Project with no linked repository', async () => {
    const { service, projectContext } = setup();
    projectContext.requireProject.mockResolvedValue({
      ...project,
      repositories: [],
    });

    await expect(service.create(DP, actor())).rejects.toMatchObject({
      response: { code: 'QA_NO_REPOSITORIES' },
    });
  });
});

describe('QaProjectRunsService.updateItem (Verification track)', () => {
  const patch = (overrides: Record<string, unknown> = {}) =>
    ({ expectedRowVersion: 1, ...overrides }) as never;

  it('a developer cannot verify', async () => {
    const { service, runs } = setup({ role: 'member' });

    await expect(
      service.updateItem(
        DP,
        actor('dev-1'),
        'run-1',
        'ri-1',
        patch({ status: 'passed' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'VERIFICATION_FORBIDDEN' } });
    expect(runs.updateItem).not.toHaveBeenCalled();
  });

  it('in_progress is not a Verification status', async () => {
    const { service } = setup();

    await expect(
      service.updateItem(
        DP,
        actor(),
        'run-1',
        'ri-1',
        patch({ status: 'in_progress' }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'QA_VERIFICATION_STATUS_INVALID' },
    });
  });

  it('failed and returned_to_dev need a severity', async () => {
    const { service } = setup();

    await expect(
      service.updateItem(
        DP,
        actor(),
        'run-1',
        'ri-1',
        patch({ status: 'failed' }),
      ),
    ).rejects.toThrow('A defect severity is required');
  });

  it('passes the two-track rules to the transaction and maps QA_PROGRESS_NOT_DONE', async () => {
    const { service, runs } = setup();
    runs.updateItem.mockRejectedValue(new QaProgressNotDoneError('ri-1'));

    await expect(
      service.updateItem(
        DP,
        actor(),
        'run-1',
        'ri-1',
        patch({ status: 'passed' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'QA_PROGRESS_NOT_DONE' } });
    expect(runs.updateItem.mock.calls[0]![6]).toEqual({
      requireProgressDoneForPass: true,
      resetProgressOnReturn: true,
    });
  });

  it('a lost race is QA_ITEM_STALE; a signed-off run is read-only', async () => {
    const { service, runs } = setup();
    runs.updateItem.mockResolvedValue(null);
    await expect(
      service.updateItem(DP, actor(), 'run-1', 'ri-1', patch({ notes: 'x' })),
    ).rejects.toMatchObject({ response: { code: 'QA_ITEM_STALE' } });

    const signed = setup({ run: runRow({ status: 'signed_off' }) });
    await expect(
      signed.service.updateItem(
        DP,
        actor(),
        'run-1',
        'ri-1',
        patch({ notes: 'x' }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('returned_to_dev tells the owner, leads and developers (not the actor), anchored on the frontend repository', async () => {
    const { service, runs, notifications } = setup();
    runs.updateItem.mockResolvedValue(
      itemRow({
        status: 'returned_to_dev',
        defect_severity: 'major',
        notes: 'Broken',
      }),
    );

    await service.updateItem(
      DP,
      actor(),
      'run-1',
      'ri-1',
      patch({ status: 'returned_to_dev', defectSeverity: 'major' }),
    );

    const calls = notifications.record.mock.calls.map(
      (call) =>
        call[0] as { userId: string; projectId: string; eventCode: string },
    );
    expect(calls.map((call) => call.userId).sort()).toEqual([
      'dev-1',
      'lead-1',
      'owner-1',
    ]);
    expect(calls.every((call) => call.projectId === 'p-web')).toBe(true);
    expect(calls[0]?.eventCode).toBe('qa.item.returned_to_dev');
  });

  it('a blocker tells the leads only', async () => {
    const { service, runs, notifications } = setup();
    runs.updateItem.mockResolvedValue(
      itemRow({ status: 'blocked', defect_severity: 'blocker' }),
    );

    await service.updateItem(
      DP,
      actor(),
      'run-1',
      'ri-1',
      patch({ status: 'blocked', defectSeverity: 'blocker' }),
    );

    expect(
      notifications.record.mock.calls.map(
        (call) => (call[0] as { userId: string }).userId,
      ),
    ).toEqual(['lead-1']);
  });
});

describe('QaProjectRunsService sign-off, reopen, current', () => {
  const signoffRow = (): QaRunSignoffRow =>
    ({
      id: 's-1',
      run_id: 'run-1',
      verdict: 'APPROVED',
      summary: null,
      conditions: null,
      signed_by: 'qa-1',
      signed_by_login: 'qa',
      signed_at: '2026-10-01T01:00:00.000Z',
      report_json: {},
      superseded_at: null,
      superseded_by: null,
      superseded_by_login: null,
    }) as QaRunSignoffRow;

  it('APPROVED needs every item passed', async () => {
    const { service, runs } = setup();

    await expect(
      service.signoff(DP, actor(), 'run-1', { verdict: 'APPROVED' }),
    ).rejects.toThrow('not yet passed');
    expect(runs.createSignoff).not.toHaveBeenCalled();
  });

  it('freezes the assembled Project run into the sign-off and notifies creator, owner and leads except the actor', async () => {
    const { service, runs, notifications } = setup({
      items: [
        itemRow({
          status: 'passed',
          verified_by: 'qa-1',
          verified_by_login: 'qa',
        }),
      ],
    });
    runs.createSignoff.mockResolvedValue({
      run: runRow({ status: 'signed_off' }),
      signoff: signoffRow(),
    });

    const result = await service.signoff(DP, actor('lead-9'), 'run-1', {
      verdict: 'APPROVED',
      summary: 'Ship it',
    });

    const frozen = runs.createSignoff.mock.calls[0]![0].reportJson as {
      scope: string;
      status: string;
      repositories: unknown[];
      signoff: { verdict: string };
    };
    expect(frozen).toMatchObject({
      scope: 'project',
      status: 'signed_off',
      signoff: { verdict: 'APPROVED' },
    });
    expect(frozen.repositories).toHaveLength(2);
    expect(result.signoff?.verdict).toBe('APPROVED');
    expect(
      notifications.record.mock.calls
        .map((call) => (call[0] as { userId: string }).userId)
        .sort(),
    ).toEqual(['lead-1', 'owner-1', 'qa-1']);
  });

  it('a stale item set at sign-off is QA_RUN_CHANGED', async () => {
    const { service, runs } = setup({
      items: [
        itemRow({
          status: 'passed',
          verified_by: 'qa-1',
          verified_by_login: 'qa',
        }),
      ],
    });
    runs.createSignoff.mockRejectedValue(
      Object.assign(new Error('changed'), { name: 'QaRunItemsChangedError' }),
    );
    const { QaRunItemsChangedError } = jest.requireActual<
      typeof import('../../infrastructure/qa-runs.repository')
    >('../../infrastructure/qa-runs.repository');
    runs.createSignoff.mockRejectedValue(new QaRunItemsChangedError('run-1'));

    await expect(
      service.signoff(DP, actor(), 'run-1', { verdict: 'REJECTED' }),
    ).rejects.toMatchObject({ response: { code: 'QA_RUN_CHANGED' } });
  });

  it('only a lead or admin reopens', async () => {
    const signed = setup({ role: 'qa', run: runRow({ status: 'signed_off' }) });
    await expect(signed.service.reopen(DP, actor(), 'run-1')).rejects.toThrow(
      ForbiddenException,
    );

    const lead = setup({ role: 'lead', run: runRow({ status: 'signed_off' }) });
    lead.runs.reopenRun.mockResolvedValue(runRow());
    const run = await lead.service.reopen(DP, actor('lead-1'), 'run-1');
    expect(run.status).toBe('open');
    expect(run.permissions.canSetVerification).toBe(true);
  });

  it('current returns the run for the current heads, else compares with the newest run', async () => {
    const hit = setup();
    hit.projectRuns.findRunByFingerprint.mockResolvedValue(runRow());
    const found = await hit.service.current(DP, actor());
    expect(found.run?.id).toBe('run-1');
    expect(found.stale).toBe(false);

    const miss = setup({
      readings: [reading(API, SHA_API), reading(WEB, MOVED)],
    });
    miss.projectRuns.findNewestProjectRun.mockResolvedValue(runRow());
    const stale = await miss.service.current(DP, actor());
    expect(stale.run).toBeNull();
    expect(stale.stale).toBe(true);
    expect(stale.heads.find((head) => head.moved)?.repoFullName).toBe(
      'acme/web',
    );
  });

  it('404s a Project the caller cannot see', async () => {
    const { service, projectContext } = setup();
    projectContext.requireProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );

    await expect(service.getById(DP, actor(), 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lists a page of runs with a cursor', async () => {
    const { service, projectRuns } = setup();
    projectRuns.listProjectRuns.mockResolvedValue([
      runRow({ id: 'r3' }),
      runRow({ id: 'r2' }),
      runRow({ id: 'r1' }),
    ]);

    const page = await service.list(DP, 'u', { limit: 2, cursor: undefined });

    expect(page.runs.map((run) => run.id)).toEqual(['r3', 'r2']);
    expect(page.next).toEqual(expect.any(String));
    expect(projectRuns.listProjectRuns.mock.calls[0]![1].limit).toBe(3);
  });
});

describe('QaProjectRunsService.myItems', () => {
  it('buckets every developer item by run item and Progress', async () => {
    const { service, projectRuns, runs } = setup({ role: 'member' });
    projectRuns.findNewestProjectRun.mockResolvedValue(runRow());
    runs.listItemsByRunId.mockResolvedValue([
      itemRow({
        id: 'ri-1',
        source_item_id: 'item-1',
        status: 'returned_to_dev',
        defect_severity: 'major',
        verified_by: 'qa-1',
        verified_by_login: 'qa',
      }),
    ]);

    const feed = await service.myItems(DP, actor('dev-1'));

    // item-1 is returned (even though its Progress is done), item-2 is todo,
    // item-3 is in_progress; nothing is ready for QA.
    expect(feed.returned.map((entry) => entry.item.id)).toEqual(['item-1']);
    expect(feed.returned[0]?.runItem?.id).toBe('ri-1');
    expect(feed.todo.map((entry) => entry.item.id)).toEqual(['item-2']);
    expect(feed.inProgress.map((entry) => entry.item.id)).toEqual(['item-3']);
    expect(feed.readyForQa).toEqual([]);
    expect(feed.todo[0]?.runItem).toBeNull();
  });

  it('a done item with a pending run item, or no run at all, is in the QA queue', async () => {
    const { service, projectRuns, runs } = setup({ role: 'qa' });
    projectRuns.findNewestProjectRun.mockResolvedValue(runRow());
    runs.listItemsByRunId.mockResolvedValue([
      itemRow({ id: 'ri-1', source_item_id: 'item-1', status: 'pending' }),
    ]);
    const withRun = await service.myItems(DP, actor());
    expect(withRun.readyForQa.map((entry) => entry.item.id)).toEqual([
      'item-1',
    ]);

    projectRuns.findNewestProjectRun.mockResolvedValue(null);
    const noRun = await service.myItems(DP, actor());
    expect(noRun.readyForQa[0]).toMatchObject({ runId: null, runItem: null });
  });

  it('uses the run for the current heads when it exists', async () => {
    const { service, projectRuns } = setup();
    projectRuns.findRunByFingerprint.mockResolvedValue(runRow({ id: 'run-1' }));

    await service.myItems(DP, actor());

    expect(projectRuns.findRunByFingerprint).toHaveBeenCalled();
    expect(projectRuns.findNewestProjectRun).not.toHaveBeenCalled();
  });
});

describe('QaProjectRunsService attachments in the run payload and report', () => {
  const refs = new Map([
    [
      'ri-1',
      [
        {
          id: 'att-1',
          caption: 'Receipt shown',
          kind: 'evidence' as const,
          contentType: 'image/png' as const,
        },
      ],
    ],
  ]);

  it('adds attachmentCount per item and the run-level enabled / canAdd flags', async () => {
    const { service, attachments } = setup({
      items: [itemRow(), itemRow({ id: 'ri-2', position: 1 })],
    });
    attachments.countsByItem.mockResolvedValue(new Map([['ri-1', 3]]));

    const run = await service.getById(DP, actor(), 'run-1');

    expect(run.items.map((item) => item.attachmentCount)).toEqual([3, 0]);
    expect(run.attachments).toEqual({
      enabled: true,
      canAdd: true,
      canAddFixProof: false,
    });
    expect(run.items[0]).not.toHaveProperty('attachments');
  });

  it('enabled is false when storage is not configured, and canAdd follows role and run state', async () => {
    const off = setup();
    off.attachments.isEnabled.mockReturnValue(false);
    expect(
      (await off.service.getById(DP, actor(), 'run-1')).attachments,
    ).toEqual({ enabled: false, canAdd: true, canAddFixProof: false });

    const dev = setup({ role: 'member' });
    expect(
      (await dev.service.getById(DP, actor(), 'run-1')).attachments,
    ).toEqual({ enabled: true, canAdd: false, canAddFixProof: true });

    const signed = setup({
      role: 'lead',
      run: runRow({ status: 'signed_off' }),
    });
    expect(
      (await signed.service.getById(DP, actor(), 'run-1')).attachments,
    ).toEqual({ enabled: true, canAdd: false, canAddFixProof: false });
  });

  it.each([
    ['member', true],
    ['lead', true],
    ['admin', true],
    ['qa', false],
  ] as const)(
    'canAddFixProof for %s on an open run is %s',
    async (role, expected) => {
      const { service } = setup({ role });
      expect(
        (await service.getById(DP, actor(), 'run-1')).attachments
          .canAddFixProof,
      ).toBe(expected);
    },
  );

  describe('fixProofCount and canAttachFixProof per item', () => {
    const FIX_REQUESTED = '2026-10-14T09:00:00.000Z';
    const rows = [
      itemRow({ id: 'ri-returned', position: 0, status: 'returned_to_dev' }),
      itemRow({
        id: 'ri-awaiting',
        position: 1,
        status: 'pending',
        fix_requested_at: FIX_REQUESTED,
      }),
      itemRow({ id: 'ri-pending', position: 2, status: 'pending' }),
      itemRow({
        id: 'ri-passed',
        position: 3,
        status: 'passed',
        fix_requested_at: FIX_REQUESTED,
      }),
      itemRow({ id: 'ri-failed', position: 4, status: 'failed' }),
      itemRow({ id: 'ri-full', position: 5, status: 'returned_to_dev' }),
    ];
    const flags = (run: ProjectQaRun) =>
      Object.fromEntries(
        run.items.map((item) => [
          item.id,
          [item.fixProofCount, item.canAttachFixProof],
        ]),
      );

    it('is true only for returned_to_dev, or pending with a fix request, below the per-kind cap', async () => {
      const { service, attachments } = setup({ role: 'member', items: rows });
      attachments.fixProofCountsByItem.mockResolvedValue(
        new Map([
          ['ri-returned', 2],
          ['ri-full', 5],
        ]),
      );

      const run = await service.getById(DP, actor(), 'run-1');

      expect(flags(run)).toEqual({
        'ri-returned': [2, true],
        'ri-awaiting': [0, true],
        'ri-pending': [0, false],
        'ri-passed': [0, false],
        'ri-failed': [0, false],
        'ri-full': [5, false],
      });
    });

    it('keeps attachmentCount as the total of every kind', async () => {
      const { service, attachments } = setup({ role: 'member', items: rows });
      attachments.countsByItem.mockResolvedValue(new Map([['ri-returned', 7]]));
      attachments.fixProofCountsByItem.mockResolvedValue(
        new Map([['ri-returned', 2]]),
      );

      const run = await service.getById(DP, actor(), 'run-1');

      expect(run.items[0]).toMatchObject({
        attachmentCount: 7,
        fixProofCount: 2,
      });
    });

    it('is false for QA, on a signed-off run, and when storage is off', async () => {
      const qa = setup({ role: 'qa', items: rows });
      expect(
        (await qa.service.getById(DP, actor(), 'run-1')).items.some(
          (item) => item.canAttachFixProof,
        ),
      ).toBe(false);

      const signed = setup({
        role: 'lead',
        items: rows,
        run: runRow({ status: 'signed_off' }),
      });
      expect(
        (await signed.service.getById(DP, actor(), 'run-1')).items.some(
          (item) => item.canAttachFixProof,
        ),
      ).toBe(false);

      const off = setup({ role: 'member', items: rows });
      off.attachments.isEnabled.mockReturnValue(false);
      expect(
        (await off.service.getById(DP, actor(), 'run-1')).items.some(
          (item) => item.canAttachFixProof,
        ),
      ).toBe(false);
    });

    it('reaches the My QA items feed through the same assembly', async () => {
      const { service, projectRuns, attachments } = setup({
        role: 'member',
        items: [
          itemRow({
            id: 'ri-1',
            source_item_id: 'item-1',
            status: 'returned_to_dev',
          }),
        ],
      });
      projectRuns.findNewestProjectRun.mockResolvedValue(runRow());
      attachments.fixProofCountsByItem.mockResolvedValue(
        new Map([['ri-1', 1]]),
      );

      const feed = await service.myItems(DP, actor('dev-1'));

      expect(feed.returned[0]?.runItem).toMatchObject({
        fixProofCount: 1,
        canAttachFixProof: true,
      });
    });
  });

  it('also counts on the current-run read', async () => {
    const { service, projectRuns, attachments } = setup();
    projectRuns.findRunByFingerprint.mockResolvedValue(runRow());
    attachments.countsByItem.mockResolvedValue(new Map([['ri-1', 2]]));

    const current = await service.current(DP, actor());

    expect(current.run?.items[0]?.attachmentCount).toBe(2);
    expect(current.run?.attachments.enabled).toBe(true);
  });

  it('freezes attachment ids and captions (no URLs) into the sign-off and guards the count', async () => {
    const { service, runs, attachments } = setup({
      items: [
        itemRow({
          status: 'passed',
          verified_by: 'qa-1',
          verified_by_login: 'qa',
        }),
      ],
    });
    attachments.referencesForRun.mockResolvedValue(refs);
    attachments.countsByItem.mockResolvedValue(new Map([['ri-1', 1]]));
    runs.createSignoff.mockResolvedValue({
      run: runRow({ status: 'signed_off' }),
      signoff: {
        id: 's-1',
        run_id: 'run-1',
        verdict: 'APPROVED',
        summary: null,
        conditions: null,
        signed_by: 'qa-1',
        signed_by_login: 'qa',
        signed_at: '2026-10-01T01:00:00.000Z',
      } as QaRunSignoffRow,
    });

    await service.signoff(DP, actor(), 'run-1', { verdict: 'APPROVED' });

    const input = runs.createSignoff.mock.calls[0]![0];
    const frozen = input.reportJson as {
      items: Array<{ attachments: unknown[] }>;
    };
    expect(frozen.items[0]?.attachments).toEqual(refs.get('ri-1'));
    expect(JSON.stringify(frozen)).not.toContain('signed.example');
    expect(input.expectedAttachmentIds).toEqual(
      refs.get('ri-1')!.map((ref) => ref.id),
    );
  });

  it('a live report carries items[].attachments; a signed-off run serves exactly its frozen report', async () => {
    const live = setup();
    live.attachments.referencesForRun.mockResolvedValue(refs);

    const liveReport = await live.service.buildReport(DP, actor(), 'run-1');

    expect(liveReport.run.items[0]?.attachments).toEqual(refs.get('ri-1'));

    const frozenRun = {
      ...(await live.service.getById(DP, actor(), 'run-1')),
      status: 'signed_off',
      items: [{ ...liveReport.run.items[0]!, attachments: refs.get('ri-1') }],
    };
    const signed = setup({ run: runRow({ status: 'signed_off' }) });
    signed.runs.findActiveSignoff.mockResolvedValue({
      ...({ id: 's-1' } as QaRunSignoffRow),
      report_json: frozenRun as unknown as Record<string, unknown>,
    });
    signed.attachments.referencesForRun.mockResolvedValue(new Map());

    const frozenReport = await signed.service.buildReport(DP, actor(), 'run-1');

    expect(frozenReport.frozen).toBe(true);
    expect(frozenReport.run.items[0]?.attachments).toEqual(refs.get('ri-1'));
  });
});
