import { NotFoundException } from '@nestjs/common';

import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  QaChecklistBatchInsertError,
  type QaChecklistItemRow,
  type QaChecklistRow,
  type QaChecklistsRepository,
} from '../../infrastructure/qa-checklists.repository';
import type { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
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
}: {
  role?: PlatformAppRole;
  member?: boolean;
  manage?: boolean;
  row?: QaChecklistRow | null;
} = {}) {
  const checklists = {
    findById: jest.fn().mockResolvedValue(row),
    listByDeliveryProject: jest.fn().mockResolvedValue([requirementRow()]),
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
    findNewestProjectRun: jest.fn().mockResolvedValue(null),
    verificationCountsByRequirement: jest.fn().mockResolvedValue(new Map()),
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
  } as unknown as jest.Mocked<QaProjectContextService>;
  const audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };
  const notifications = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new QaRequirementsService(
    checklists,
    requirements,
    projectRuns,
    runs,
    access,
    projectContext,
    audit,
    notifications,
  );
  return {
    service,
    checklists,
    requirements,
    projectRuns,
    runs,
    access,
    projectContext,
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
      { deliveryProjectId: DP, kind: 'system' },
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

    expect(overview.groups).toEqual([
      {
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
      },
    ]);
    expect(overview.unassigned.map((row) => row.id)).toEqual(['req-2']);
    expect(overview.permissions.canManage).toBe(false);
  });

  it('the overview carries the newest run verification counts and status', async () => {
    const { service, projectRuns } = setup();
    projectRuns.findNewestProjectRun.mockResolvedValue({
      id: 'run-1',
      status: 'signed_off',
    } as never);
    projectRuns.verificationCountsByRequirement.mockResolvedValue(
      new Map([
        [
          'req-1',
          { pending: 0, passed: 1, failed: 0, blocked: 0, returned_to_dev: 0 },
        ],
      ]),
    );

    const overview = await service.overview('group-1', 'lead-1', false);

    expect(overview.groups[0]?.requirements[0]).toMatchObject({
      latestRunStatus: 'signed_off',
      verification: { passed: 1 },
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
      { deliveryProjectId: DP, kind: 'functional' },
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
