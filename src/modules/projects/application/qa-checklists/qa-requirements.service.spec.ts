import { Logger, NotFoundException } from '@nestjs/common';

import type { AuditLatestEventQueryPort } from '#kernel/ports/audit.port';
import type { DeliveryProjectOverviewFacts } from '#kernel/ports/delivery-project-overview.port';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  deliveredIterationRow,
  fakeIterations,
  iterationRow,
} from '../../__fixtures__/project-iterations';
import type { ProjectIterationRow } from '../../infrastructure/project-iterations.repository';
import {
  QaChecklistBatchInsertError,
  type QaChecklistItemRow,
  type QaChecklistRow,
  type QaChecklistsRepository,
} from '../../infrastructure/qa-checklists.repository';
import type {
  QaProjectRunHeadline,
  QaProjectRunsRepository,
  QaRunItemFact,
} from '../../infrastructure/qa-project-runs.repository';
import type { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type { QaRunsRepository } from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from './qa-access.service';
import type {
  QaProjectContext,
  QaProjectContextService,
} from './qa-project-context.service';
import { QaRequirementsService } from './qa-requirements.service';

const DP = 'dp-1';
const actor = { userId: 'dev-1', userLogin: 'dev' };

const requirementRow = (
  overrides: Partial<QaChecklistRow> = {},
): QaChecklistRow => ({
  id: 'req-1',
  workspace_id: 'group-1',
  name: 'Checkout',
  description: null,
  version: 3,
  archived_at: null,
  created_by: 'lead-1',
  updated_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  kind: 'functional',
  delivery_project_id: DP,
  iteration_id: 'it-1',
  legacy_checklist_id: null,
  ...overrides,
});

const itemRow = (
  overrides: Partial<QaChecklistItemRow> = {},
): QaChecklistItemRow => ({
  id: 'item-1',
  checklist_id: 'req-1',
  position: 0,
  title: 'Pay by card',
  description: null,
  target_persona: 'all',
  verification_type: 'manual',
  test_identifier: null,
  acceptance_criteria: 'Receipt shown',
  progress: 'todo',
  progress_by: null,
  progress_by_login: null,
  progress_at: null,
  row_version: 1,
  updated_at: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const headline = (
  overrides: Partial<QaProjectRunHeadline> = {},
): QaProjectRunHeadline => ({
  deliveryProjectId: DP,
  runId: 'run-1',
  status: 'open',
  createdAt: '2026-10-02T00:00:00.000000Z',
  verdict: null,
  signedAt: null,
  signedByLogin: null,
  ...overrides,
});

const signedOffHeadline = (
  overrides: Partial<QaProjectRunHeadline> = {},
): QaProjectRunHeadline =>
  headline({
    status: 'signed_off',
    verdict: 'APPROVED',
    signedAt: '2026-10-03T08:00:00.000000Z',
    signedByLogin: 'qa-lead',
    ...overrides,
  });

const runFact = (overrides: Partial<QaRunItemFact> = {}): QaRunItemFact => ({
  runId: 'run-1',
  sourceItemId: 'item-1',
  requirementId: 'req-1',
  status: 'pending',
  defectSeverity: null,
  ...overrides,
});

const overviewFacts = (
  overrides: Partial<DeliveryProjectOverviewFacts> = {},
): DeliveryProjectOverviewFacts => ({
  developers: 0,
  qa: 0,
  viewerKind: null,
  repositories: [],
  ...overrides,
});

const project: QaProjectContext = {
  deliveryProjectId: DP,
  groupId: 'group-1',
  name: 'Checkout',
  repositories: [],
};

function setup({
  role = 'lead',
  member = true,
  manage,
  row = requirementRow(),
  iteration = iterationRow(),
}: {
  role?: PlatformAppRole;
  member?: boolean;
  manage?: boolean;
  row?: QaChecklistRow | null;
  iteration?: ProjectIterationRow;
} = {}) {
  const checklists = {
    findById: jest.fn().mockResolvedValue(row),
    listByIteration: jest.fn().mockResolvedValue([requirementRow()]),
    listItemsByChecklistIds: jest
      .fn()
      .mockResolvedValue(new Map([['req-1', [itemRow()]]])),
    hasActiveNameConflict: jest.fn().mockResolvedValue(false),
    createManyWithItems: jest
      .fn()
      .mockImplementation((inputs: Array<{ name: string }>) =>
        Promise.resolve(
          inputs.map((input, index) => ({
            checklist: requirementRow({
              id: `req-${index + 1}`,
              name: input.name,
            }),
            items: [itemRow({ id: `item-${index + 1}` })],
          })),
        ),
      ),
    createWithItems: jest.fn().mockResolvedValue({
      checklist: requirementRow(),
      items: [itemRow()],
    }),
    updateMeta: jest.fn(),
    archive: jest.fn(),
    deleteByDeliveryProject: jest.fn().mockResolvedValue(2),
  } as unknown as jest.Mocked<QaChecklistsRepository>;
  const requirements = {
    findItem: jest.fn().mockResolvedValue(itemRow()),
    setProgress: jest.fn(),
    reorderItems: jest.fn(),
    appendItem: jest.fn(),
    updateItemDefinition: jest.fn(),
    deleteItem: jest.fn(),
    listByWorkspace: jest.fn().mockResolvedValue([requirementRow()]),
  } as unknown as jest.Mocked<QaRequirementsRepository>;
  const projectRuns = {
    findReturnedOpenRunItems: jest.fn().mockResolvedValue([]),
    findLatestRunHeadlines: jest.fn().mockResolvedValue(new Map()),
    listItemFactsByRunIds: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const runs = {
    requestRetest: jest.fn().mockResolvedValue({ id: 'ri-1' }),
  } as unknown as jest.Mocked<QaRunsRepository>;
  const access = {
    findAppRole: jest.fn().mockResolvedValue(role),
    canAccessWorkspace: jest.fn().mockResolvedValue(member),
    canManage: jest
      .fn()
      .mockResolvedValue(manage ?? (role === 'lead' || role === 'admin')),
    listWorkspaceQaIds: jest.fn().mockResolvedValue(['qa-1', 'dev-1']),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    requireProject: jest.fn().mockResolvedValue(project),
    findProject: jest.fn().mockResolvedValue(project),
    anchorProjectId: jest.fn().mockResolvedValue('p-web'),
    listGroupProjects: jest
      .fn()
      .mockResolvedValue([{ id: DP, name: 'Checkout' }]),
    listOverviewFacts: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const auditQuery = {
    findLatestProjectEventTimes: jest.fn().mockResolvedValue(new Map()),
  } as jest.Mocked<AuditLatestEventQueryPort>;
  const audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };
  const notifications = { record: jest.fn().mockResolvedValue(undefined) };
  const { service: iterations, repository: iterationRepository } =
    fakeIterations(iteration);
  const service = new QaRequirementsService(
    checklists,
    requirements,
    projectRuns,
    runs,
    access,
    projectContext,
    iterations,
    auditQuery,
    audit,
    notifications,
  );
  return {
    service,
    iterationRepository,
    checklists,
    requirements,
    projectRuns,
    runs,
    access,
    projectContext,
    auditQuery,
    audit,
    notifications,
  };
}

describe('QaRequirementsService - who may define requirements', () => {
  it('a non-member of the Project group gets 404 before any role check', async () => {
    const fixture = setup();
    fixture.projectContext.requireProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );

    await expect(
      fixture.service.create(DP, 'stranger', { kind: 'system', name: 'x' }),
    ).rejects.toThrow(NotFoundException);
    expect(fixture.access.canManage).not.toHaveBeenCalled();
  });

  it.each(['member', 'qa'] as const)(
    '%s gets 403 REQUIREMENT_MANAGE_FORBIDDEN',
    async (role) => {
      const { service, checklists } = setup({ role });

      await expect(
        service.create(DP, 'user-1', { kind: 'system', name: 'API checks' }),
      ).rejects.toMatchObject({
        response: { code: 'REQUIREMENT_MANAGE_FORBIDDEN' },
      });
      expect(checklists.createWithItems).not.toHaveBeenCalled();
    },
  );

  it.each(['lead', 'admin'] as const)(
    '%s creates a functional requirement with stories',
    async (role) => {
      const { service, checklists, audit } = setup({ role });

      const created = await service.create(DP, 'lead-1', {
        kind: 'functional',
        name: '  Checkout  ',
        items: [{ title: 'Pay by card', acceptanceCriteria: 'Receipt shown' }],
      });

      expect(checklists.createWithItems).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'group-1',
          name: 'Checkout',
          kind: 'functional',
          deliveryProjectId: DP,
          items: [
            expect.objectContaining({
              title: 'Pay by card',
              acceptanceCriteria: 'Receipt shown',
              targetPersona: 'all',
              verificationType: 'manual',
            }),
          ],
        }),
      );
      expect(created).toMatchObject({
        kind: 'functional',
        deliveryProjectId: DP,
        progressCounts: { todo: 1, in_progress: 0, done: 0 },
      });
      expect(created.items[0]).toMatchObject({
        acceptanceCriteria: 'Receipt shown',
        progress: 'todo',
        canSetProgress: true,
      });
      expect(audit.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventCode: 'qa.requirement.created' }),
      );
    },
  );

  it('rejects an unknown kind and a taken name with coded errors', async () => {
    const { service, checklists } = setup();
    await expect(
      service.create(DP, 'lead-1', { kind: 'epic', name: 'x' }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_KIND_INVALID' } });

    checklists.hasActiveNameConflict.mockResolvedValue(true);
    await expect(
      service.create(DP, 'lead-1', { kind: 'system', name: 'Dup' }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_NAME_TAKEN' } });
    expect(checklists.hasActiveNameConflict).toHaveBeenCalledWith(
      'group-1',
      'Dup',
      undefined,
      { iterationId: 'it-1', kind: 'system' },
    );
  });

  it('PATCH answers REQUIREMENT_STALE and REQUIREMENT_ARCHIVED', async () => {
    const { service } = setup();
    await expect(
      service.update('req-1', 'lead-1', { expectedVersion: 1 }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_STALE' } });

    const archived = setup({
      row: requirementRow({ archived_at: '2026-10-01T00:00:00.000Z' }),
    });
    await expect(
      archived.service.update('req-1', 'lead-1', { expectedVersion: 3 }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_ARCHIVED' } });
  });

  it('reorder with anything but the exact item set is REQUIREMENT_ORDER_MISMATCH', async () => {
    const { service, requirements } = setup();
    requirements.reorderItems.mockResolvedValue(false);

    await expect(
      service.reorderItems('req-1', 'lead-1', { itemIds: ['item-1'] }),
    ).rejects.toMatchObject({
      response: { code: 'REQUIREMENT_ORDER_MISMATCH' },
    });
  });

  it('item edits are by id, stale on a moved row_version', async () => {
    const { service, requirements } = setup();
    requirements.updateItemDefinition.mockResolvedValue(null);

    await expect(
      service.updateItem('req-1', 'item-1', 'lead-1', {
        expectedRowVersion: 9,
        title: 'New',
      }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_ITEM_STALE' } });
    expect(requirements.updateItemDefinition).toHaveBeenCalledWith(
      'req-1',
      'item-1',
      9,
      { title: 'New' },
    );
  });

  it('purgeDeliveryProject deletes the Project requirements only', async () => {
    const { service, checklists } = setup();

    expect(await service.purgeDeliveryProject(DP)).toEqual({ removed: 2 });
    expect(checklists.deleteByDeliveryProject).toHaveBeenCalledWith(DP);
  });
});

describe('QaRequirementsService.setProgress', () => {
  const done = (overrides: Partial<QaChecklistItemRow> = {}) =>
    itemRow({ progress: 'done', row_version: 2, ...overrides });

  it.each(['member', 'lead', 'admin'] as const)(
    '%s may set Progress',
    async (role) => {
      const { service, requirements } = setup({ role });
      requirements.setProgress.mockResolvedValue(
        itemRow({ progress: 'in_progress', row_version: 2 }),
      );

      const result = await service.setProgress('req-1', 'item-1', actor, {
        progress: 'in_progress',
        expectedRowVersion: 1,
      });

      expect(result.item.progress).toBe('in_progress');
      expect(result.readyForQaNotified).toBe(false);
    },
  );

  it('QA gets 403 PROGRESS_FORBIDDEN and nothing is written', async () => {
    const { service, requirements } = setup({ role: 'qa' });

    await expect(
      service.setProgress('req-1', 'item-1', actor, {
        progress: 'done',
        expectedRowVersion: 1,
      }),
    ).rejects.toMatchObject({ response: { code: 'PROGRESS_FORBIDDEN' } });
    expect(requirements.setProgress).not.toHaveBeenCalled();
  });

  it('a stale row_version is REQUIREMENT_ITEM_STALE; an archived requirement is REQUIREMENT_ARCHIVED', async () => {
    const stale = setup({ role: 'member' });
    stale.requirements.setProgress.mockResolvedValue(null);
    await expect(
      stale.service.setProgress('req-1', 'item-1', actor, {
        progress: 'done',
        expectedRowVersion: 1,
      }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_ITEM_STALE' } });

    const archived = setup({
      role: 'member',
      row: requirementRow({ archived_at: '2026-10-01T00:00:00.000Z' }),
    });
    await expect(
      archived.service.setProgress('req-1', 'item-1', actor, {
        progress: 'done',
        expectedRowVersion: 1,
      }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_ARCHIVED' } });
  });

  it('done re-queues a returned run item and tells QA (previous verifier included), never the actor', async () => {
    const { service, requirements, projectRuns, runs, notifications } = setup({
      role: 'member',
    });
    requirements.setProgress.mockResolvedValue(done());
    projectRuns.findReturnedOpenRunItems.mockResolvedValue([
      { id: 'ri-1', run_id: 'run-1', verified_by: 'qa-9' },
    ] as never);

    const result = await service.setProgress('req-1', 'item-1', actor, {
      progress: 'done',
      expectedRowVersion: 1,
      note: 'fixed it',
    });

    expect(runs.requestRetest).toHaveBeenCalledWith(
      'run-1',
      'ri-1',
      { id: 'dev-1', login: 'dev' },
      'fixed it',
    );
    expect(result.readyForQaNotified).toBe(true);
    const recipients = notifications.record.mock.calls
      .map((call) => (call[0] as { userId: string }).userId)
      .sort();
    expect(recipients).toEqual(['qa-1', 'qa-9']);
    expect(notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p-web',
        eventCode: 'qa.item.retest_requested',
        title: 'Ready for QA: "Pay by card"',
      }),
    );
  });

  it('done notifies QA even when no run item was returned', async () => {
    const { service, requirements, runs, notifications } = setup({
      role: 'member',
    });
    requirements.setProgress.mockResolvedValue(done());

    const result = await service.setProgress('req-1', 'item-1', actor, {
      progress: 'done',
      expectedRowVersion: 1,
    });

    expect(runs.requestRetest).not.toHaveBeenCalled();
    expect(result.readyForQaNotified).toBe(true);
    expect(notifications.record).toHaveBeenCalledTimes(1);
  });

  it('moving away from done notifies nobody', async () => {
    const { service, requirements, notifications } = setup({ role: 'member' });
    requirements.setProgress.mockResolvedValue(itemRow({ row_version: 3 }));

    const result = await service.setProgress('req-1', 'item-1', actor, {
      progress: 'todo',
      expectedRowVersion: 2,
    });

    expect(result.readyForQaNotified).toBe(false);
    expect(notifications.record).not.toHaveBeenCalled();
  });
});

describe('QaRequirementsService reads', () => {
  it('lists a Project requirements with caller permissions', async () => {
    const { service } = setup({ role: 'member' });

    const result = await service.listForProject(DP, 'dev-1', {
      kind: 'functional',
      includeArchived: false,
    });

    expect(result.deliveryProject).toEqual({
      id: DP,
      name: 'Checkout',
      groupId: 'group-1',
    });
    expect(result.permissions).toEqual({
      canManage: false,
      canSetProgress: true,
    });
    expect(result.requirements[0]?.items[0]?.canSetProgress).toBe(true);
  });

  it('rejects a bad kind filter', async () => {
    const { service } = setup();

    await expect(
      service.listForProject(DP, 'u', { kind: 'nope', includeArchived: false }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_KIND_INVALID' } });
  });

  it('the overview groups requirements by Project, with unassigned apart and no verification before a run', async () => {
    const { service, requirements } = setup({ role: 'qa' });
    requirements.listByWorkspace.mockResolvedValue([
      requirementRow(),
      requirementRow({
        id: 'req-2',
        delivery_project_id: null,
        kind: 'system',
      }),
    ]);

    const overview = await service.overview('group-1', 'qa-1', false);

    expect(overview.groups).toHaveLength(1);
    expect(overview.groups[0]).toMatchObject({
      deliveryProject: { id: DP, name: 'Checkout' },
      requirements: [
        expect.objectContaining({
          id: 'req-1',
          kind: 'functional',
          itemCount: 1,
          verification: null,
          latestRunStatus: null,
        }),
      ],
    });
    expect(overview.unassigned.map((row) => row.id)).toEqual(['req-2']);
    expect(overview.permissions.canManage).toBe(false);
  });

  it('the overview carries the newest run verification counts and status', async () => {
    const { service, projectRuns } = setup();
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, headline({ status: 'signed_off' })]]),
    );
    projectRuns.listItemFactsByRunIds.mockResolvedValue(
      new Map([
        [
          'run-1',
          [
            runFact({ status: 'passed' }),
            // A legacy 'in_progress' folds into pending, like the per-run tally.
            runFact({ sourceItemId: 'item-2', status: 'in_progress' }),
          ],
        ],
      ]),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups[0]?.requirements[0]).toMatchObject({
      latestRunStatus: 'signed_off',
      verification: {
        pending: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
        returned_to_dev: 0,
      },
    });
  });

  it('the overview 404s a non-member', async () => {
    const { service } = setup({ member: false });

    await expect(
      service.overview('group-1', 'stranger', false),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('QaRequirementsService.createBatch', () => {
  const draft = (name: string) => ({
    name,
    items: [{ title: `${name} story`, acceptanceCriteria: 'ok' }],
  });

  it('creates every requirement in one transaction and answers in request order', async () => {
    const { service, checklists, audit } = setup();

    const result = await service.createBatch(DP, 'lead-1', {
      kind: 'functional',
      requirements: [draft('  Checkout '), draft('Search'), draft('Profile')],
    });

    expect(checklists.createManyWithItems).toHaveBeenCalledTimes(1);
    expect(checklists.createWithItems).not.toHaveBeenCalled();
    expect(checklists.createManyWithItems.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        name: 'Checkout',
        kind: 'functional',
        deliveryProjectId: DP,
        workspaceId: 'group-1',
        createdBy: 'lead-1',
      }),
      expect.objectContaining({ name: 'Search' }),
      expect.objectContaining({ name: 'Profile' }),
    ]);
    expect(result.requirements.map((r) => r.name)).toEqual([
      'Checkout',
      'Search',
      'Profile',
    ]);
    // The same shape the single create returns.
    expect(result.requirements[0]).toMatchObject({
      kind: 'functional',
      deliveryProjectId: DP,
      progressCounts: { todo: 1, in_progress: 0, done: 0 },
    });
    expect(result.requirements[0]?.items[0]).toMatchObject({
      progress: 'todo',
      canSetProgress: true,
    });
    expect(audit.recordProjectEvent).toHaveBeenCalledTimes(3);
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'qa.requirement.created' }),
    );
  });

  it('is atomic: a failure mid-batch creates nothing and records no audit', async () => {
    const { service, checklists, audit } = setup();
    checklists.createManyWithItems.mockRejectedValue(new Error('boom'));

    await expect(
      service.createBatch(DP, 'lead-1', {
        kind: 'system',
        requirements: [draft('A'), draft('B')],
      }),
    ).rejects.toThrow('boom');
    expect(audit.recordProjectEvent).not.toHaveBeenCalled();
  });

  it('maps a unique violation inside the transaction to REQUIREMENT_NAME_TAKEN with the index', async () => {
    const { service, checklists, audit } = setup();
    checklists.createManyWithItems.mockRejectedValue(
      new QaChecklistBatchInsertError(1, { code: '23505' }),
    );

    await expect(
      service.createBatch(DP, 'lead-1', {
        kind: 'system',
        requirements: [draft('A'), draft('B'), draft('C')],
      }),
    ).rejects.toMatchObject({
      response: { code: 'REQUIREMENT_NAME_TAKEN', index: 1, statusCode: 409 },
    });
    expect(audit.recordProjectEvent).not.toHaveBeenCalled();
  });

  it('refuses a name that collides with an existing active requirement, naming the index', async () => {
    const { service, checklists } = setup();
    checklists.hasActiveNameConflict.mockImplementation(
      (_group: string, name: string) => Promise.resolve(name === 'B'),
    );

    await expect(
      service.createBatch(DP, 'lead-1', {
        kind: 'functional',
        requirements: [draft('A'), draft('B'), draft('C')],
      }),
    ).rejects.toMatchObject({
      response: { code: 'REQUIREMENT_NAME_TAKEN', index: 1 },
    });
    expect(checklists.hasActiveNameConflict).toHaveBeenCalledWith(
      'group-1',
      'A',
      undefined,
      { iterationId: 'it-1', kind: 'functional' },
    );
    expect(checklists.createManyWithItems).not.toHaveBeenCalled();
  });

  it('refuses a duplicate name inside the batch (trimmed, case-insensitive) at the SECOND occurrence', async () => {
    const { service, checklists } = setup();

    await expect(
      service.createBatch(DP, 'lead-1', {
        kind: 'functional',
        requirements: [draft('Alpha'), draft('Beta'), draft('  alpha ')],
      }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 400,
        code: 'REQUIREMENT_BATCH_DUPLICATE_NAME',
        index: 2,
      },
    });
    expect(checklists.createManyWithItems).not.toHaveBeenCalled();
  });

  it('refuses an empty batch and more than 20 with REQUIREMENT_BATCH_INVALID', async () => {
    const { service, checklists } = setup();

    await expect(
      service.createBatch(DP, 'lead-1', { kind: 'system', requirements: [] }),
    ).rejects.toMatchObject({
      response: { statusCode: 400, code: 'REQUIREMENT_BATCH_INVALID' },
    });
    await expect(
      service.createBatch(DP, 'lead-1', {
        kind: 'system',
        requirements: Array.from({ length: 21 }, (_, i) => draft(`R${i}`)),
      }),
    ).rejects.toMatchObject({
      response: { code: 'REQUIREMENT_BATCH_INVALID' },
    });
    expect(checklists.createManyWithItems).not.toHaveBeenCalled();

    // Exactly 20 is fine.
    await expect(
      service.createBatch(DP, 'lead-1', {
        kind: 'system',
        requirements: Array.from({ length: 20 }, (_, i) => draft(`R${i}`)),
      }),
    ).resolves.toMatchObject({ requirements: expect.any(Array) });
  });

  it('rejects an unknown kind', async () => {
    const { service } = setup();
    await expect(
      service.createBatch(DP, 'lead-1', {
        kind: 'epic',
        requirements: [draft('A')],
      }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_KIND_INVALID' } });
  });

  it.each(['member', 'qa'] as const)(
    '%s gets 403 REQUIREMENT_MANAGE_FORBIDDEN',
    async (role) => {
      const { service, checklists } = setup({ role });
      await expect(
        service.createBatch(DP, 'user-1', {
          kind: 'system',
          requirements: [draft('A')],
        }),
      ).rejects.toMatchObject({
        response: { code: 'REQUIREMENT_MANAGE_FORBIDDEN' },
      });
      expect(checklists.createManyWithItems).not.toHaveBeenCalled();
    },
  );

  it.each(['lead', 'admin'] as const)('%s may create a batch', async (role) => {
    const { service } = setup({ role });
    const result = await service.createBatch(DP, 'user-1', {
      kind: 'functional',
      requirements: [draft('A')],
    });
    expect(result.requirements).toHaveLength(1);
  });

  it('a non-member gets 404 before any role check', async () => {
    const fixture = setup();
    fixture.projectContext.requireProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );
    await expect(
      fixture.service.createBatch(DP, 'stranger', {
        kind: 'system',
        requirements: [draft('A')],
      }),
    ).rejects.toThrow(NotFoundException);
    expect(fixture.access.canManage).not.toHaveBeenCalled();
  });
});

describe('QaRequirementsService.overview - Project dashboard fields', () => {
  const API = { projectId: 'p-api', repoFullName: 'acme/api' };
  const WEB = { projectId: 'p-web', repoFullName: 'acme/web' };

  it('a Project with no run: no latestRun, zero defects, no promotion', async () => {
    const { service, projectRuns, auditQuery } = setup({ role: 'qa' });
    projectRuns.findLatestRunHeadlines.mockResolvedValue(new Map());

    const overview = await service.overview('group-1', 'qa-1', false);

    expect(overview.groups[0]).toMatchObject({
      latestRun: null,
      counts: {
        openDefects: { blocker: 0, major: 0, minor: 0, unrated: 0 },
        members: { developer: 0, qa: 0 },
      },
      promotion: null,
      viewerMembership: null,
    });
    expect(auditQuery.findLatestProjectEventTimes).not.toHaveBeenCalled();
  });

  it('an open run: verdict and sign-off are null and promotion is not read', async () => {
    const { service, projectRuns, projectContext, auditQuery } = setup();
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, headline()]]),
    );
    projectContext.listOverviewFacts.mockResolvedValue(
      new Map([[DP, overviewFacts({ repositories: [API, WEB] })]]),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups[0]?.latestRun).toEqual({
      id: 'run-1',
      status: 'open',
      createdAt: '2026-10-02T00:00:00.000000Z',
      verdict: null,
      signedOffAt: null,
      signedOffBy: null,
    });
    expect(overview.groups[0]?.promotion).toBeNull();
    expect(auditQuery.findLatestProjectEventTimes).not.toHaveBeenCalled();
  });

  it('a signed-off APPROVED run with 1 of 2 repositories merged', async () => {
    const { service, projectRuns, projectContext, auditQuery } = setup();
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, signedOffHeadline()]]),
    );
    projectContext.listOverviewFacts.mockResolvedValue(
      new Map([[DP, overviewFacts({ repositories: [API, WEB] })]]),
    );
    auditQuery.findLatestProjectEventTimes.mockResolvedValue(
      new Map([['p-api', '2026-10-04T09:30:00.123456Z']]),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups[0]?.latestRun).toEqual({
      id: 'run-1',
      status: 'signed_off',
      createdAt: '2026-10-02T00:00:00.000000Z',
      verdict: 'APPROVED',
      signedOffAt: '2026-10-03T08:00:00.000000Z',
      signedOffBy: 'qa-lead',
    });
    expect(overview.groups[0]?.promotion).toEqual({
      mergedRepositories: 1,
      totalRepositories: 2,
      lastMergedAt: '2026-10-04T09:30:00.123456Z',
    });
    // One audit read, bounded per repository by the sign-off time.
    expect(auditQuery.findLatestProjectEventTimes).toHaveBeenCalledTimes(1);
    expect(auditQuery.findLatestProjectEventTimes).toHaveBeenCalledWith(
      'qa.promotion.merged',
      [
        { projectId: 'p-api', since: '2026-10-03T08:00:00.000000Z' },
        { projectId: 'p-web', since: '2026-10-03T08:00:00.000000Z' },
      ],
    );
  });

  it('lastMergedAt is the newest merge across repositories; none merged is 0 of N', async () => {
    const { service, projectRuns, projectContext, auditQuery } = setup();
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, signedOffHeadline({ verdict: 'CONDITIONAL' })]]),
    );
    projectContext.listOverviewFacts.mockResolvedValue(
      new Map([[DP, overviewFacts({ repositories: [API, WEB] })]]),
    );
    auditQuery.findLatestProjectEventTimes.mockResolvedValue(
      new Map([
        ['p-api', '2026-10-04T09:30:00.000000Z'],
        ['p-web', '2026-10-05T11:00:00.000000Z'],
      ]),
    );
    const both = await service.overview('group-1', 'lead-1', false);
    expect(both.groups[0]?.promotion).toEqual({
      mergedRepositories: 2,
      totalRepositories: 2,
      lastMergedAt: '2026-10-05T11:00:00.000000Z',
    });

    auditQuery.findLatestProjectEventTimes.mockResolvedValue(new Map());
    const none = await service.overview('group-1', 'lead-1', false);
    expect(none.groups[0]?.promotion).toEqual({
      mergedRepositories: 0,
      totalRepositories: 2,
      lastMergedAt: null,
    });
    expect(none.groups[0]?.latestRun?.verdict).toBe('CONDITIONAL');
  });

  it('promotion is left out, not shown as 0 merged, when merges cannot be read', async () => {
    const { service, projectRuns, projectContext, auditQuery } = setup();
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, signedOffHeadline()]]),
    );
    projectContext.listOverviewFacts.mockResolvedValue(
      new Map([[DP, overviewFacts({ repositories: [API] })]]),
    );

    // Audit recording is off: the port answers null.
    auditQuery.findLatestProjectEventTimes.mockResolvedValue(null);
    const off = await service.overview('group-1', 'lead-1', false);
    expect(off.groups[0]?.promotion).toBeNull();
    expect(off.groups[0]?.latestRun?.status).toBe('signed_off');

    // The read failed: the Checklists page must still load.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    auditQuery.findLatestProjectEventTimes.mockRejectedValue(
      new Error('audit down'),
    );
    const failed = await service.overview('group-1', 'lead-1', false);
    expect(failed.groups[0]?.promotion).toBeNull();
    expect(failed.groups[0]?.counts.members).toEqual({ developer: 0, qa: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a signed-off Project with no linked repository reports 0 of 0', async () => {
    const { service, projectRuns, auditQuery } = setup();
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, signedOffHeadline()]]),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups[0]?.promotion).toEqual({
      mergedRepositories: 0,
      totalRepositories: 0,
      lastMergedAt: null,
    });
    expect(auditQuery.findLatestProjectEventTimes).not.toHaveBeenCalled();
  });

  it('groups open defects by severity; a null severity is unrated; only failed, blocked and returned count', async () => {
    const { service, projectRuns } = setup();
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, headline()]]),
    );
    projectRuns.listItemFactsByRunIds.mockResolvedValue(
      new Map([
        [
          'run-1',
          [
            runFact({ status: 'failed', defectSeverity: 'blocker' }),
            runFact({ status: 'blocked', defectSeverity: 'blocker' }),
            runFact({ status: 'returned_to_dev', defectSeverity: 'major' }),
            runFact({ status: 'failed', defectSeverity: 'minor' }),
            runFact({ status: 'failed', defectSeverity: null }),
            runFact({ status: 'returned_to_dev', defectSeverity: null }),
            // Not open defects, whatever severity they still carry.
            runFact({ status: 'passed', defectSeverity: 'major' }),
            runFact({ status: 'pending', defectSeverity: 'blocker' }),
          ],
        ],
      ]),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups[0]?.counts.openDefects).toEqual({
      blocker: 2,
      major: 1,
      minor: 1,
      unrated: 2,
    });
  });

  it('readyForQa counts done items whose run item is pending or missing, by the My QA items rule', async () => {
    const { service, checklists, projectRuns, requirements } = setup();
    requirements.listByWorkspace.mockResolvedValue([
      requirementRow(),
      requirementRow({ id: 'req-arch', archived_at: '2026-10-02T00:00:00Z' }),
    ]);
    const done = (id: string, checklistId = 'req-1') =>
      itemRow({ id, checklist_id: checklistId, progress: 'done' });
    checklists.listItemsByChecklistIds.mockResolvedValue(
      new Map([
        [
          'req-1',
          [
            done('i-no-run-item'), // ready: no run item
            done('i-pending'), // ready: run item pending
            done('i-passed'), // decided
            done('i-failed'), // decided
            done('i-blocked'), // decided
            done('i-returned'), // returned bucket, not ready
            done('i-legacy'), // legacy in_progress run item is not pending
            itemRow({ id: 'i-todo', progress: 'todo' }),
            itemRow({ id: 'i-working', progress: 'in_progress' }),
            itemRow({ id: 'i-todo-pending', progress: 'todo' }),
          ],
        ],
        // The feed lists active requirements only, so an archived one's done
        // item never counts even when the overview includes archived rows.
        ['req-arch', [done('i-archived', 'req-arch')]],
      ]),
    );
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([[DP, headline()]]),
    );
    projectRuns.listItemFactsByRunIds.mockResolvedValue(
      new Map([
        [
          'run-1',
          [
            runFact({ sourceItemId: 'i-pending', status: 'pending' }),
            runFact({ sourceItemId: 'i-passed', status: 'passed' }),
            runFact({ sourceItemId: 'i-failed', status: 'failed' }),
            runFact({ sourceItemId: 'i-blocked', status: 'blocked' }),
            runFact({ sourceItemId: 'i-returned', status: 'returned_to_dev' }),
            runFact({ sourceItemId: 'i-legacy', status: 'in_progress' }),
            runFact({ sourceItemId: 'i-todo-pending', status: 'pending' }),
            // A run item whose source requirement item was deleted.
            runFact({ sourceItemId: null, status: 'pending' }),
          ],
        ],
      ]),
    );

    const overview = await service.overview('group-1', 'lead-1', true);

    expect(overview.groups[0]?.counts.readyForQa).toBe(2);
  });

  it('with no run every done item is ready for QA', async () => {
    const { service, checklists } = setup();
    checklists.listItemsByChecklistIds.mockResolvedValue(
      new Map([
        [
          'req-1',
          [
            itemRow({ id: 'a', progress: 'done' }),
            itemRow({ id: 'b', progress: 'done' }),
            itemRow({ id: 'c', progress: 'todo' }),
          ],
        ],
      ]),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups[0]?.latestRun).toBeNull();
    expect(overview.groups[0]?.counts.readyForQa).toBe(2);
  });

  it('members come from the hierarchy port; viewerMembership is the caller own kind or null', async () => {
    const { service, projectContext } = setup();
    projectContext.listGroupProjects.mockResolvedValue([
      { id: 'dp-dev', name: 'As developer' },
      { id: 'dp-qa', name: 'As QA' },
      { id: 'dp-none', name: 'Not a member' },
      { id: 'dp-unknown', name: 'No facts at all' },
    ]);
    projectContext.listOverviewFacts.mockResolvedValue(
      new Map([
        [
          'dp-dev',
          overviewFacts({ developers: 3, qa: 1, viewerKind: 'developer' }),
        ],
        ['dp-qa', overviewFacts({ developers: 0, qa: 2, viewerKind: 'qa' })],
        ['dp-none', overviewFacts({ developers: 2, qa: 2 })],
      ]),
    );

    const overview = await service.overview('group-1', 'dev-1', false);

    expect(
      overview.groups.map((group) => [
        group.deliveryProject.id,
        group.counts.members,
        group.viewerMembership,
      ]),
    ).toEqual([
      ['dp-dev', { developer: 3, qa: 1 }, 'developer'],
      ['dp-qa', { developer: 0, qa: 2 }, 'qa'],
      ['dp-none', { developer: 2, qa: 2 }, null],
      ['dp-unknown', { developer: 0, qa: 0 }, null],
    ]);
    expect(projectContext.listOverviewFacts).toHaveBeenCalledWith(
      ['dp-dev', 'dp-qa', 'dp-none', 'dp-unknown'],
      'dev-1',
    );
  });

  it('a Project with zero requirements still gets every new field', async () => {
    const { service, projectContext, projectRuns, requirements } = setup();
    projectContext.listGroupProjects.mockResolvedValue([
      { id: 'dp-empty', name: 'Empty' },
    ]);
    requirements.listByWorkspace.mockResolvedValue([]);
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map([
        [
          'dp-empty',
          headline({ deliveryProjectId: 'dp-empty', runId: 'run-empty' }),
        ],
      ]),
    );
    projectContext.listOverviewFacts.mockResolvedValue(
      new Map([
        ['dp-empty', overviewFacts({ developers: 1, qa: 1, viewerKind: 'qa' })],
      ]),
    );

    const overview = await service.overview('group-1', 'qa-1', false);

    expect(overview.groups).toEqual([
      {
        deliveryProject: { id: 'dp-empty', name: 'Empty' },
        requirements: [],
        latestRun: expect.objectContaining({ id: 'run-empty', status: 'open' }),
        counts: {
          readyForQa: 0,
          openDefects: { blocker: 0, major: 0, minor: 0, unrated: 0 },
          members: { developer: 1, qa: 1 },
        },
        promotion: null,
        viewerMembership: 'qa',
      },
    ]);
  });

  it('keeps the existing keys and reads once per field, however many Projects there are', async () => {
    const {
      service,
      projectContext,
      projectRuns,
      auditQuery,
      requirements,
      iterationRepository,
    } = setup();
    const ids = ['dp-1', 'dp-2', 'dp-3', 'dp-4', 'dp-5'];
    const iterationIds = ids.map((id) => `it-${id}`);
    projectContext.listGroupProjects.mockResolvedValue(
      ids.map((id) => ({ id, name: id })),
    );
    iterationRepository.findCurrentByDeliveryProjects.mockResolvedValue(
      new Map(
        ids.map((id) => [
          id,
          iterationRow({ id: `it-${id}`, delivery_project_id: id }),
        ]),
      ),
    );
    requirements.listByWorkspace.mockResolvedValue(
      ids.map((id) =>
        requirementRow({ id: `req-${id}`, delivery_project_id: id }),
      ),
    );
    projectRuns.findLatestRunHeadlines.mockResolvedValue(
      new Map(
        ids.map((id) => [
          id,
          signedOffHeadline({ deliveryProjectId: id, runId: `run-${id}` }),
        ]),
      ),
    );
    projectContext.listOverviewFacts.mockResolvedValue(
      new Map(
        ids.map((id) => [
          id,
          overviewFacts({
            repositories: [
              { projectId: `p-${id}`, repoFullName: `acme/${id}` },
            ],
          }),
        ]),
      ),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups).toHaveLength(5);
    expect(Object.keys(overview).sort()).toEqual([
      'groups',
      'permissions',
      'unassigned',
    ]);
    expect(Object.keys(overview.groups[0] ?? {}).sort()).toEqual([
      'counts',
      'deliveryProject',
      'latestRun',
      'promotion',
      'requirements',
      'viewerMembership',
    ]);
    expect(projectRuns.findLatestRunHeadlines).toHaveBeenCalledTimes(1);
    // Batched by Iteration: each Project's CURRENT one, in one query each.
    expect(
      iterationRepository.findCurrentByDeliveryProjects,
    ).toHaveBeenCalledWith(ids);
    expect(projectRuns.findLatestRunHeadlines).toHaveBeenCalledWith(
      iterationIds,
    );
    expect(requirements.listByWorkspace).toHaveBeenCalledWith(
      'group-1',
      false,
      iterationIds,
    );
    expect(projectRuns.listItemFactsByRunIds).toHaveBeenCalledTimes(1);
    expect(projectRuns.listItemFactsByRunIds).toHaveBeenCalledWith(
      ids.map((id) => `run-${id}`),
    );
    expect(projectContext.listOverviewFacts).toHaveBeenCalledTimes(1);
    expect(auditQuery.findLatestProjectEventTimes).toHaveBeenCalledTimes(1);
    expect(
      auditQuery.findLatestProjectEventTimes.mock.calls[0]?.[1],
    ).toHaveLength(5);
  });
});

describe('QaRequirementsService - Iterations', () => {
  const DELIVERED = deliveredIterationRow({ number: 3 });
  const CODE = 'ITERATION_DELIVERED';

  it('create and createBatch store the active Iteration of the Project on every new requirement', async () => {
    const { service, checklists } = setup();

    await service.create(DP, 'lead-1', { kind: 'system', name: 'API checks' });
    await service.createBatch(DP, 'lead-1', {
      kind: 'functional',
      requirements: [{ name: 'A' }, { name: 'B' }],
    });

    expect(checklists.createWithItems).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryProjectId: DP, iterationId: 'it-1' }),
    );
    expect(checklists.createManyWithItems).toHaveBeenCalledWith([
      expect.objectContaining({ iterationId: 'it-1' }),
      expect.objectContaining({ iterationId: 'it-1' }),
    ]);
  });

  it('lists the requirements of the current Iteration only', async () => {
    const { service, checklists } = setup();

    await service.listForProject(DP, 'lead-1', {
      kind: undefined,
      includeArchived: true,
    });

    expect(checklists.listByIteration).toHaveBeenCalledWith('it-1', {
      includeArchived: true,
    });
  });

  it('the same name may exist in another Iteration: the conflict check is scoped to one Iteration', async () => {
    const { service, checklists } = setup({
      iteration: iterationRow({ id: 'it-2', number: 2 }),
    });

    await service.create(DP, 'lead-1', { kind: 'system', name: 'Checkout' });

    expect(checklists.hasActiveNameConflict).toHaveBeenCalledWith(
      'group-1',
      'Checkout',
      undefined,
      { iterationId: 'it-2', kind: 'system' },
    );
  });

  it('an update checks the name against the own Iteration of the requirement', async () => {
    const { service, checklists } = setup({
      row: requirementRow({ iteration_id: 'it-7' }),
    });
    checklists.updateMeta.mockResolvedValue(requirementRow({ name: 'New' }));

    await service.update('req-1', 'lead-1', {
      expectedVersion: 3,
      name: 'New',
    });

    expect(checklists.hasActiveNameConflict).toHaveBeenCalledWith(
      'group-1',
      'New',
      'req-1',
      { iterationId: 'it-7', kind: 'functional' },
    );
  });

  describe('a delivered Iteration refuses every requirement write (409 ITERATION_DELIVERED)', () => {
    type Call = (fixture: ReturnType<typeof setup>) => Promise<unknown>;
    const writes: Array<[string, Call]> = [
      [
        'create',
        (f) => f.service.create(DP, 'lead-1', { kind: 'system', name: 'x' }),
      ],
      [
        'createBatch',
        (f) =>
          f.service.createBatch(DP, 'lead-1', {
            kind: 'system',
            requirements: [{ name: 'x' }],
          }),
      ],
      [
        'update',
        (f) => f.service.update('req-1', 'lead-1', { expectedVersion: 3 }),
      ],
      ['archive', (f) => f.service.archive('req-1', 'lead-1')],
      [
        'addItem',
        (f) => f.service.addItem('req-1', 'lead-1', { title: 'Another' }),
      ],
      [
        'updateItem',
        (f) =>
          f.service.updateItem('req-1', 'item-1', 'lead-1', {
            expectedRowVersion: 1,
            title: 'Renamed',
          }),
      ],
      ['deleteItem', (f) => f.service.deleteItem('req-1', 'item-1', 'lead-1')],
      [
        'reorderItems',
        (f) =>
          f.service.reorderItems('req-1', 'lead-1', { itemIds: ['item-1'] }),
      ],
      [
        'setProgress',
        (f) =>
          f.service.setProgress('req-1', 'item-1', actor, {
            progress: 'done',
            expectedRowVersion: 1,
          }),
      ],
    ];

    it.each(writes)('%s', async (_name, call) => {
      const fixture = setup({
        role: 'lead',
        iteration: DELIVERED,
        row: requirementRow({ iteration_id: DELIVERED.id }),
      });

      await expect(call(fixture)).rejects.toMatchObject({
        response: {
          code: CODE,
          message:
            'Iteration 3 was delivered. Start the next iteration to change this.',
        },
      });
      expect(fixture.checklists.createWithItems).not.toHaveBeenCalled();
      expect(fixture.checklists.createManyWithItems).not.toHaveBeenCalled();
      expect(fixture.checklists.updateMeta).not.toHaveBeenCalled();
      expect(fixture.checklists.archive).not.toHaveBeenCalled();
      expect(fixture.requirements.appendItem).not.toHaveBeenCalled();
      expect(fixture.requirements.updateItemDefinition).not.toHaveBeenCalled();
      expect(fixture.requirements.deleteItem).not.toHaveBeenCalled();
      expect(fixture.requirements.reorderItems).not.toHaveBeenCalled();
      expect(fixture.requirements.setProgress).not.toHaveBeenCalled();
    });

    it('reads stay open: the requirements of a delivered Iteration still list', async () => {
      const { service } = setup({ iteration: DELIVERED });

      await expect(
        service.listForProject(DP, 'lead-1', {
          kind: undefined,
          includeArchived: false,
        }),
      ).resolves.toMatchObject({ requirements: [{ id: 'req-1' }] });
    });

    it('a requirement with no Iteration (an unassigned legacy checklist) is not guarded', async () => {
      const { service, requirements } = setup({
        role: 'lead',
        row: requirementRow({
          kind: 'system',
          delivery_project_id: null,
          iteration_id: null,
        }),
      });
      requirements.reorderItems.mockResolvedValue(true);

      await expect(
        service.reorderItems('req-1', 'lead-1', { itemIds: ['item-1'] }),
      ).resolves.toBeDefined();
    });
  });
});
