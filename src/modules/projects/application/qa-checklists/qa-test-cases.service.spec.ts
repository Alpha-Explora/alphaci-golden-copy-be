import { NotFoundException } from '@nestjs/common';

import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  deliveredIterationRow,
  fakeIterations,
} from '../../__fixtures__/project-iterations';
import type {
  QaChecklistItemRow,
  QaChecklistRow,
  QaChecklistsRepository,
} from '../../infrastructure/qa-checklists.repository';
import type { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type { QaTestCasesRepository } from '../../infrastructure/qa-test-cases.repository';
import type { QaAccessService } from './qa-access.service';
import { QaTestCasesService } from './qa-test-cases.service';

const requirementRow = (
  overrides: Partial<QaChecklistRow> = {},
): QaChecklistRow => ({
  id: 'req-1',
  workspace_id: 'group-1',
  name: 'Customer Authentication',
  description: null,
  version: 1,
  archived_at: null,
  created_by: 'lead-1',
  updated_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  kind: 'functional',
  delivery_project_id: 'dp-1',
  iteration_id: 'it-1',
  legacy_checklist_id: null,
  ...overrides,
});

const storyRow = {
  id: 'item-1',
  title: 'Returning customer logs in',
} as QaChecklistItemRow;

function setup({
  role = 'qa',
  member = true,
  requirement = requirementRow(),
  delivered = false,
}: {
  role?: PlatformAppRole;
  member?: boolean;
  requirement?: QaChecklistRow | null;
  delivered?: boolean;
} = {}) {
  const checklists = {
    findById: jest.fn().mockResolvedValue(requirement),
  } as unknown as jest.Mocked<QaChecklistsRepository>;
  const requirements = {
    findItem: jest.fn().mockResolvedValue(storyRow),
  } as unknown as jest.Mocked<QaRequirementsRepository>;
  const testCases = {
    listByItemIds: jest.fn().mockResolvedValue(new Map()),
    countCategories: jest.fn().mockResolvedValue(0),
    countTestCases: jest.fn().mockResolvedValue(0),
    findCategory: jest.fn().mockResolvedValue({ id: 'cat-1' }),
    findTestCase: jest.fn().mockResolvedValue({ id: 'tc-1' }),
    createCategory: jest.fn().mockResolvedValue({ id: 'cat-1' }),
    renameCategory: jest.fn().mockResolvedValue({ id: 'cat-1' }),
    deleteCategory: jest.fn().mockResolvedValue(true),
    createTestCase: jest.fn().mockResolvedValue({ id: 'tc-1' }),
    updateTestCase: jest.fn().mockResolvedValue({ id: 'tc-1' }),
    deleteTestCase: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<QaTestCasesRepository>;
  const access = {
    findAppRole: jest.fn().mockResolvedValue(role),
    canAccessWorkspace: jest.fn().mockResolvedValue(member),
  } as unknown as jest.Mocked<QaAccessService>;
  const audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };
  const { service: iterations } = fakeIterations(
    delivered ? deliveredIterationRow() : undefined,
  );
  const service = new QaTestCasesService(
    checklists,
    requirements,
    testCases,
    access,
    iterations,
    audit,
  );
  return { service, testCases, audit };
}

describe('QaTestCasesService - who writes test cases', () => {
  it.each(['qa', 'admin'] as const)(
    '%s adds a category, trimmed, and re-syncs the Iteration',
    async (role) => {
      const { service, testCases, audit } = setup({ role });

      const result = await service.createCategory('req-1', 'item-1', 'u-1', {
        name: '  Happy path ',
      });

      expect(testCases.createCategory).toHaveBeenCalledWith(
        'item-1',
        'Happy path',
        'u-1',
        'it-1',
      );
      expect(result).toEqual({ itemId: 'item-1', testCategories: [] });
      expect(audit.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'qa.requirement.test_cases_changed',
        }),
      );
    },
  );

  it.each(['lead', 'member'] as const)(
    '%s is refused: the QA Team writes test cases',
    async (role) => {
      const { service, testCases } = setup({ role });

      await expect(
        service.createCategory('req-1', 'item-1', 'u-1', {
          name: 'Happy path',
        }),
      ).rejects.toMatchObject({
        response: { code: 'TEST_CASE_MANAGE_FORBIDDEN' },
      });
      expect(testCases.createCategory).not.toHaveBeenCalled();
    },
  );

  it('a non-member of the group gets 404, not 403', async () => {
    const { service } = setup({ member: false });

    await expect(
      service.createCategory('req-1', 'item-1', 'u-1', { name: 'Happy path' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('QaTestCasesService - which stories take test cases', () => {
  it('refuses a System requirement item: test cases belong to User stories', async () => {
    const { service } = setup({
      requirement: requirementRow({ kind: 'system' }),
    });

    await expect(
      service.createCategory('req-1', 'item-1', 'u-1', { name: 'Happy path' }),
    ).rejects.toMatchObject({ response: { code: 'TEST_CASES_STORY_ONLY' } });
  });

  it('refuses an archived Feature', async () => {
    const { service } = setup({
      requirement: requirementRow({ archived_at: '2026-10-02T00:00:00.000Z' }),
    });

    await expect(
      service.createTestCase('req-1', 'item-1', 'cat-1', 'u-1', { title: 'x' }),
    ).rejects.toMatchObject({ response: { code: 'REQUIREMENT_ARCHIVED' } });
  });

  it('refuses a delivered Iteration', async () => {
    const { service, testCases } = setup({ delivered: true });

    await expect(
      service.deleteTestCase('req-1', 'item-1', 'tc-1', 'u-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(testCases.deleteTestCase).not.toHaveBeenCalled();
  });
});

describe('QaTestCasesService - writes', () => {
  it('a duplicate category name is TEST_CATEGORY_NAME_TAKEN', async () => {
    const { service, testCases } = setup();
    testCases.createCategory.mockRejectedValue({ code: '23505' });

    await expect(
      service.createCategory('req-1', 'item-1', 'u-1', { name: 'Happy path' }),
    ).rejects.toMatchObject({ response: { code: 'TEST_CATEGORY_NAME_TAKEN' } });
  });

  it('caps categories per story and test cases per category', async () => {
    const { service, testCases } = setup();
    testCases.countCategories.mockResolvedValue(30);
    testCases.countTestCases.mockResolvedValue(100);

    await expect(
      service.createCategory('req-1', 'item-1', 'u-1', { name: 'One more' }),
    ).rejects.toMatchObject({ response: { code: 'TEST_CASES_LIMIT' } });
    await expect(
      service.createTestCase('req-1', 'item-1', 'cat-1', 'u-1', {
        title: 'One more',
      }),
    ).rejects.toMatchObject({ response: { code: 'TEST_CASES_LIMIT' } });
  });

  it('adds a test case into a category of this story; a blank expected result is stored as null', async () => {
    const { service, testCases } = setup();

    await service.createTestCase('req-1', 'item-1', 'cat-1', 'u-1', {
      title: ' Logs in with a saved password ',
      expectedResult: '   ',
    });

    expect(testCases.findCategory).toHaveBeenCalledWith('item-1', 'cat-1');
    expect(testCases.createTestCase).toHaveBeenCalledWith(
      'cat-1',
      { title: 'Logs in with a saved password', expectedResult: null },
      'u-1',
      'it-1',
    );
  });

  it('a category of another story is 404', async () => {
    const { service, testCases } = setup();
    testCases.findCategory.mockResolvedValue(null);

    await expect(
      service.createTestCase('req-1', 'item-1', 'cat-9', 'u-1', { title: 'x' }),
    ).rejects.toThrow(NotFoundException);
    expect(testCases.createTestCase).not.toHaveBeenCalled();
  });

  it('edits only the fields sent, and a lost race is TEST_CASE_STALE', async () => {
    const { service, testCases } = setup();

    await service.updateTestCase('req-1', 'item-1', 'tc-1', 'u-1', {
      expectedRowVersion: 3,
      expectedResult: null,
    });
    expect(testCases.updateTestCase).toHaveBeenCalledWith(
      'tc-1',
      3,
      { expectedResult: null },
      'it-1',
    );

    testCases.updateTestCase.mockResolvedValue(null);
    await expect(
      service.updateTestCase('req-1', 'item-1', 'tc-1', 'u-1', {
        expectedRowVersion: 3,
        title: 'x',
      }),
    ).rejects.toMatchObject({ response: { code: 'TEST_CASE_STALE' } });
  });

  it('deleting a missing category or test case is 404', async () => {
    const { service, testCases } = setup();
    testCases.deleteCategory.mockResolvedValue(false);
    testCases.findTestCase.mockResolvedValue(null);

    await expect(
      service.deleteCategory('req-1', 'item-1', 'cat-1', 'u-1'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.deleteTestCase('req-1', 'item-1', 'tc-1', 'u-1'),
    ).rejects.toThrow(NotFoundException);
  });
});
