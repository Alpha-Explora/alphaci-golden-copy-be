import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { QaChecklistsService } from './qa-checklists.service';
import type { QaAccessService } from './qa-access.service';
import type {
  QaChecklistItemRow,
  QaChecklistRow,
  QaChecklistsRepository,
} from '../../infrastructure/qa-checklists.repository';

const checklistRow = (
  overrides: Partial<QaChecklistRow> = {},
): QaChecklistRow => ({
  id: 'checklist-1',
  workspace_id: 'workspace-1',
  name: 'Release checklist',
  description: null,
  version: 1,
  archived_at: null,
  created_by: 'lead-1',
  updated_by: null,
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

const itemRow = (
  overrides: Partial<QaChecklistItemRow> = {},
): QaChecklistItemRow => ({
  id: 'item-1',
  checklist_id: 'checklist-1',
  position: 0,
  title: 'Smoke test login',
  description: null,
  target_persona: 'qa',
  verification_type: 'manual',
  test_identifier: null,
  ...overrides,
});

const makeRepository = (
  overrides: Partial<jest.Mocked<QaChecklistsRepository>> = {},
) =>
  ({
    createWithItems: jest.fn(),
    findById: jest.fn(),
    listByWorkspace: jest.fn().mockResolvedValue([]),
    listByProject: jest.fn().mockResolvedValue([]),
    listItemsByChecklistIds: jest.fn().mockResolvedValue(new Map()),
    listSharedProjectIdsByChecklistIds: jest.fn().mockResolvedValue(new Map()),
    hasActiveNameConflict: jest.fn().mockResolvedValue(false),
    updateMeta: jest.fn(),
    replaceItems: jest.fn(),
    archive: jest.fn(),
    validWorkspaceProjectIds: jest.fn(),
    replaceSharedProjects: jest.fn(),
    ...overrides,
  }) as unknown as jest.Mocked<QaChecklistsRepository>;

const makeAccess = (overrides: Partial<jest.Mocked<QaAccessService>> = {}) =>
  ({
    canAccessWorkspace: jest.fn().mockResolvedValue(true),
    canManage: jest.fn().mockResolvedValue(true),
    findVisibleProjectWorkspace: jest.fn(),
    ...overrides,
  }) as unknown as jest.Mocked<QaAccessService>;

describe('QaChecklistsService — permission matrix', () => {
  it('a non-member of the workspace gets 404 on read, before any role check', async () => {
    const repository = makeRepository();
    const access = makeAccess({
      canAccessWorkspace: jest.fn().mockResolvedValue(false),
    });
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.listForWorkspace('workspace-1', 'stranger', false),
    ).rejects.toThrow(NotFoundException);
    expect(access.canManage).not.toHaveBeenCalled();
  });

  it('a non-member gets 404 on create, not 403', async () => {
    const repository = makeRepository();
    const access = makeAccess({
      canAccessWorkspace: jest.fn().mockResolvedValue(false),
    });
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.createForWorkspace('workspace-1', 'stranger', {
        name: 'New checklist',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('a member with app_role qa/member gets 403 on create', async () => {
    const repository = makeRepository();
    const access = makeAccess({
      canManage: jest.fn().mockResolvedValue(false),
    });
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.createForWorkspace('workspace-1', 'qa-user', {
        name: 'New checklist',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(repository.createWithItems).not.toHaveBeenCalled();
  });

  it('a lead/admin can create a checklist', async () => {
    const repository = makeRepository({
      createWithItems: jest.fn().mockResolvedValue({
        checklist: checklistRow(),
        items: [itemRow()],
      }),
    });
    const access = makeAccess();
    const recordProjectEvent = jest.fn().mockResolvedValue(undefined);
    const service = new QaChecklistsService(repository, access, {
      recordProjectEvent,
    });

    const result = await service.createForWorkspace('workspace-1', 'lead-1', {
      name: 'Release checklist',
      items: [
        {
          title: 'Smoke test login',
          targetPersona: 'qa',
          verificationType: 'manual',
        },
      ],
    });

    expect(repository.createWithItems).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      name: 'Release checklist',
      description: null,
      createdBy: 'lead-1',
      items: [
        {
          title: 'Smoke test login',
          targetPersona: 'qa',
          verificationType: 'manual',
        },
      ],
    });
    expect(recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'qa.checklist.created' }),
    );
    expect(result).toMatchObject({
      id: 'checklist-1',
      workspaceId: 'workspace-1',
      name: 'Release checklist',
      sharedProjectIds: [],
    });
    expect(result.items).toHaveLength(1);
  });

  it('rejects a duplicate active checklist name in the same workspace with 409', async () => {
    const repository = makeRepository({
      hasActiveNameConflict: jest.fn().mockResolvedValue(true),
    });
    const access = makeAccess();
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.createForWorkspace('workspace-1', 'lead-1', {
        name: 'Release checklist',
      }),
    ).rejects.toThrow(ConflictException);
    expect(repository.createWithItems).not.toHaveBeenCalled();
  });
});

describe('QaChecklistsService — versioning and archival', () => {
  it('updateMeta rejects a stale expectedVersion with 409', async () => {
    const repository = makeRepository({
      findById: jest.fn().mockResolvedValue(checklistRow({ version: 3 })),
    });
    const access = makeAccess();
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.updateMeta('checklist-1', 'lead-1', {
        expectedVersion: 1,
        name: 'New name',
      }),
    ).rejects.toThrow(ConflictException);
    expect(repository.updateMeta).not.toHaveBeenCalled();
  });

  it('updateMeta rejects editing an archived checklist with 409', async () => {
    const repository = makeRepository({
      findById: jest
        .fn()
        .mockResolvedValue(
          checklistRow({ archived_at: '2026-09-01T00:00:00.000Z' }),
        ),
    });
    const access = makeAccess();
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.updateMeta('checklist-1', 'lead-1', {
        expectedVersion: 1,
        name: 'New name',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('updateMeta surfaces a lost race (repository returns null) as 409', async () => {
    const repository = makeRepository({
      findById: jest.fn().mockResolvedValue(checklistRow({ version: 1 })),
      updateMeta: jest.fn().mockResolvedValue(null),
    });
    const access = makeAccess();
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.updateMeta('checklist-1', 'lead-1', {
        expectedVersion: 1,
        name: 'New name',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('replaceItems bumps the version and swaps the whole item list', async () => {
    const repository = makeRepository({
      findById: jest.fn().mockResolvedValue(checklistRow({ version: 1 })),
      replaceItems: jest.fn().mockResolvedValue({
        checklist: checklistRow({ version: 2 }),
        items: [itemRow({ position: 0, title: 'New item' })],
      }),
      listSharedProjectIdsByChecklistIds: jest
        .fn()
        .mockResolvedValue(new Map([['checklist-1', ['project-1']]])),
    });
    const access = makeAccess();
    const service = new QaChecklistsService(repository, access);

    const result = await service.replaceItems('checklist-1', 'lead-1', {
      expectedVersion: 1,
      items: [
        {
          title: 'New item',
          targetPersona: 'all',
          verificationType: 'manual',
        },
      ],
    });

    expect(repository.replaceItems).toHaveBeenCalledWith(
      'checklist-1',
      1,
      [
        {
          title: 'New item',
          targetPersona: 'all',
          verificationType: 'manual',
        },
      ],
      'lead-1',
    );
    expect(result.version).toBe(2);
    expect(result.sharedProjectIds).toEqual(['project-1']);
  });

  it('archive is idempotent and only emits the audit event on the real transition', async () => {
    const repository = makeRepository({
      findById: jest
        .fn()
        .mockResolvedValue(
          checklistRow({ archived_at: '2026-09-01T00:00:00.000Z' }),
        ),
      archive: jest
        .fn()
        .mockResolvedValue(
          checklistRow({ archived_at: '2026-09-01T00:00:00.000Z' }),
        ),
    });
    const access = makeAccess();
    const recordProjectEvent = jest.fn().mockResolvedValue(undefined);
    const service = new QaChecklistsService(repository, access, {
      recordProjectEvent,
    });

    const result = await service.archive('checklist-1', 'lead-1');

    expect(result.archivedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(recordProjectEvent).not.toHaveBeenCalled();
  });
});

describe('QaChecklistsService — sharing', () => {
  it('rejects sharing to a project outside the checklist workspace with 400', async () => {
    const repository = makeRepository({
      findById: jest.fn().mockResolvedValue(checklistRow()),
      validWorkspaceProjectIds: jest.fn().mockResolvedValue(['project-1']),
    });
    const access = makeAccess();
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.setSharedProjects('checklist-1', 'lead-1', {
        projectIds: ['project-1', 'project-from-another-workspace'],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repository.replaceSharedProjects).not.toHaveBeenCalled();
  });

  it('shares to a de-duplicated, workspace-valid project list', async () => {
    const repository = makeRepository({
      findById: jest.fn().mockResolvedValue(checklistRow()),
      validWorkspaceProjectIds: jest.fn().mockResolvedValue(['project-1']),
      replaceSharedProjects: jest.fn().mockResolvedValue(['project-1']),
    });
    const access = makeAccess();
    const recordProjectEvent = jest.fn().mockResolvedValue(undefined);
    const service = new QaChecklistsService(repository, access, {
      recordProjectEvent,
    });

    const result = await service.setSharedProjects('checklist-1', 'lead-1', {
      projectIds: ['project-1', 'project-1'],
    });

    expect(repository.validWorkspaceProjectIds).toHaveBeenCalledWith(
      'workspace-1',
      ['project-1'],
    );
    expect(repository.replaceSharedProjects).toHaveBeenCalledWith(
      'checklist-1',
      ['project-1'],
      'lead-1',
    );
    expect(result.sharedProjectIds).toEqual(['project-1']);
    expect(recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'qa.checklist.shared' }),
    );
  });

  it('rejects sharing on an archived checklist with 409', async () => {
    const repository = makeRepository({
      findById: jest
        .fn()
        .mockResolvedValue(
          checklistRow({ archived_at: '2026-09-01T00:00:00.000Z' }),
        ),
    });
    const access = makeAccess();
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.setSharedProjects('checklist-1', 'lead-1', {
        projectIds: ['project-1'],
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('QaChecklistsService — project-scoped read', () => {
  it('404s when the project is not visible to the caller', async () => {
    const repository = makeRepository();
    const access = makeAccess({
      findVisibleProjectWorkspace: jest.fn().mockResolvedValue(null),
    });
    const service = new QaChecklistsService(repository, access);

    await expect(
      service.listForProject('project-1', 'stranger'),
    ).rejects.toThrow(NotFoundException);
  });

  it('canManage is false for a detached project with no workspace', async () => {
    const repository = makeRepository();
    const access = makeAccess({
      findVisibleProjectWorkspace: jest
        .fn()
        .mockResolvedValue({ workspaceId: null }),
    });
    const service = new QaChecklistsService(repository, access);

    const result = await service.listForProject('project-1', 'member-1');

    expect(result.canManage).toBe(false);
    expect(access.canManage).not.toHaveBeenCalled();
  });

  it('canManage is true only when the caller is both a workspace member and lead/admin', async () => {
    const repository = makeRepository();
    const access = makeAccess({
      findVisibleProjectWorkspace: jest
        .fn()
        .mockResolvedValue({ workspaceId: 'workspace-1' }),
      canAccessWorkspace: jest.fn().mockResolvedValue(true),
      canManage: jest.fn().mockResolvedValue(true),
    });
    const service = new QaChecklistsService(repository, access);

    const result = await service.listForProject('project-1', 'lead-1');

    expect(result.canManage).toBe(true);
  });
});
