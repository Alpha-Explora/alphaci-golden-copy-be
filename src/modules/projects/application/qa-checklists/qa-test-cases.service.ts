import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { canManageTestCases } from '../../domain/qa-run-access.rules';
import {
  QA_UNIQUE_VIOLATION,
  QaChecklistsRepository,
  type QaChecklistItemRow,
  type QaChecklistRow,
} from '../../infrastructure/qa-checklists.repository';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import {
  QaTestCasesRepository,
  toTestCategories,
} from '../../infrastructure/qa-test-cases.repository';
import type { CreateTestCaseDto } from './dto/create-test-case.dto';
import type { CreateTestCategoryDto } from './dto/create-test-category.dto';
import type { UpdateTestCaseDto } from './dto/update-test-case.dto';
import type { UpdateTestCategoryDto } from './dto/update-test-category.dto';
import { ProjectIterationsService } from './project-iterations.service';
import { QaAccessService } from './qa-access.service';
import {
  requirementArchived,
  testCaseManageForbidden,
  testCaseStale,
  testCasesLimit,
  testCasesStoryOnly,
  testCategoryNameTaken,
} from './qa-errors';
import {
  QA_TEST_CASES_PER_CATEGORY_MAX,
  QA_TEST_CATEGORIES_MAX,
  type StoryTestCases,
} from './qa-requirements.contracts';

type AuditEventSink = Pick<AuditEventPublisher, 'recordProjectEvent'>;

const TEST_CASES_CHANGED_EVENT = 'qa.requirement.test_cases_changed';

/** The story a test case write targets, after every check passed. */
interface StoryScope {
  requirement: QaChecklistRow;
  item: QaChecklistItemRow;
  userId: string;
}

/**
 * QA's test cases under a User story (ADR-0014, amendment 10): categories and
 * the cases inside them. Only QA and admins write them; any member of the
 * Project's group reads them (they ride on the requirement and run payloads).
 *
 * Same two authorization layers as requirements: a non-member of the group
 * gets 404, then the allow-list (canManageTestCases). The story must belong
 * to a Feature (functional requirement) that is neither archived nor in a
 * delivered Iteration. Every write answers the story's whole set of test
 * cases, and re-syncs the Iteration's open QA runs in the same transaction.
 */
@Injectable()
export class QaTestCasesService {
  constructor(
    private readonly checklists: QaChecklistsRepository,
    private readonly requirements: QaRequirementsRepository,
    private readonly testCases: QaTestCasesRepository,
    private readonly access: QaAccessService,
    private readonly iterations: ProjectIterationsService,
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventSink,
  ) {}

  async createCategory(
    requirementId: string,
    itemId: string,
    userId: string,
    dto: CreateTestCategoryDto,
  ): Promise<StoryTestCases> {
    const scope = await this.requireWritableStory(
      requirementId,
      itemId,
      userId,
    );
    const name = requireNonBlank(dto.name, 'name');
    if (
      (await this.testCases.countCategories(itemId)) >= QA_TEST_CATEGORIES_MAX
    ) {
      throw testCasesLimit(
        `A story holds at most ${QA_TEST_CATEGORIES_MAX} test case categories.`,
      );
    }
    try {
      const category = await this.testCases.createCategory(
        itemId,
        name,
        userId,
        scope.requirement.iteration_id,
      );
      await this.recordEvent(scope, {
        change: 'category_added',
        categoryId: category.id,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw testCategoryNameTaken(name);
      }
      throw error;
    }
    return this.storyTestCases(itemId);
  }

  async updateCategory(
    requirementId: string,
    itemId: string,
    categoryId: string,
    userId: string,
    dto: UpdateTestCategoryDto,
  ): Promise<StoryTestCases> {
    const scope = await this.requireWritableStory(
      requirementId,
      itemId,
      userId,
    );
    await this.requireCategory(itemId, categoryId);
    const name = requireNonBlank(dto.name, 'name');
    let renamed;
    try {
      renamed = await this.testCases.renameCategory(
        itemId,
        categoryId,
        dto.expectedRowVersion,
        name,
        scope.requirement.iteration_id,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw testCategoryNameTaken(name);
      }
      throw error;
    }
    if (!renamed) {
      throw testCaseStale(dto.expectedRowVersion);
    }
    await this.recordEvent(scope, { change: 'category_renamed', categoryId });
    return this.storyTestCases(itemId);
  }

  async deleteCategory(
    requirementId: string,
    itemId: string,
    categoryId: string,
    userId: string,
  ): Promise<StoryTestCases> {
    const scope = await this.requireWritableStory(
      requirementId,
      itemId,
      userId,
    );
    if (
      !(await this.testCases.deleteCategory(
        itemId,
        categoryId,
        scope.requirement.iteration_id,
      ))
    ) {
      throw new NotFoundException('Test case category not found');
    }
    await this.recordEvent(scope, { change: 'category_deleted', categoryId });
    return this.storyTestCases(itemId);
  }

  async createTestCase(
    requirementId: string,
    itemId: string,
    categoryId: string,
    userId: string,
    dto: CreateTestCaseDto,
  ): Promise<StoryTestCases> {
    const scope = await this.requireWritableStory(
      requirementId,
      itemId,
      userId,
    );
    await this.requireCategory(itemId, categoryId);
    if (
      (await this.testCases.countTestCases(categoryId)) >=
      QA_TEST_CASES_PER_CATEGORY_MAX
    ) {
      throw testCasesLimit(
        `A category holds at most ${QA_TEST_CASES_PER_CATEGORY_MAX} test cases.`,
      );
    }
    const testCase = await this.testCases.createTestCase(
      categoryId,
      {
        title: requireNonBlank(dto.title, 'title'),
        expectedResult: blankToNull(dto.expectedResult),
      },
      userId,
      scope.requirement.iteration_id,
    );
    await this.recordEvent(scope, {
      change: 'test_case_added',
      categoryId,
      testCaseId: testCase.id,
    });
    return this.storyTestCases(itemId);
  }

  async updateTestCase(
    requirementId: string,
    itemId: string,
    testCaseId: string,
    userId: string,
    dto: UpdateTestCaseDto,
  ): Promise<StoryTestCases> {
    const scope = await this.requireWritableStory(
      requirementId,
      itemId,
      userId,
    );
    if (!(await this.testCases.findTestCase(itemId, testCaseId))) {
      throw new NotFoundException('Test case not found');
    }
    const updated = await this.testCases.updateTestCase(
      testCaseId,
      dto.expectedRowVersion,
      {
        // exactOptionalPropertyTypes: omit absent keys.
        ...(dto.title !== undefined
          ? { title: requireNonBlank(dto.title, 'title') }
          : {}),
        ...(dto.expectedResult !== undefined
          ? { expectedResult: blankToNull(dto.expectedResult) }
          : {}),
      },
      scope.requirement.iteration_id,
    );
    if (!updated) {
      throw testCaseStale(dto.expectedRowVersion);
    }
    await this.recordEvent(scope, { change: 'test_case_edited', testCaseId });
    return this.storyTestCases(itemId);
  }

  async deleteTestCase(
    requirementId: string,
    itemId: string,
    testCaseId: string,
    userId: string,
  ): Promise<StoryTestCases> {
    const scope = await this.requireWritableStory(
      requirementId,
      itemId,
      userId,
    );
    if (!(await this.testCases.findTestCase(itemId, testCaseId))) {
      throw new NotFoundException('Test case not found');
    }
    await this.testCases.deleteTestCase(
      testCaseId,
      scope.requirement.iteration_id,
    );
    await this.recordEvent(scope, { change: 'test_case_deleted', testCaseId });
    return this.storyTestCases(itemId);
  }

  private async storyTestCases(itemId: string): Promise<StoryTestCases> {
    const definitions = await this.testCases.listByItemIds([itemId]);
    return {
      itemId,
      testCategories: toTestCategories(definitions.get(itemId) ?? []),
    };
  }

  /** 404 for a non-member or a missing story, then the role, the Iteration, the archive and the kind. */
  private async requireWritableStory(
    requirementId: string,
    itemId: string,
    userId: string,
  ): Promise<StoryScope> {
    const requirement = await this.checklists.findById(requirementId);
    if (
      !requirement ||
      !(await this.access.canAccessWorkspace(userId, requirement.workspace_id))
    ) {
      throw new NotFoundException('Requirement not found');
    }
    const item = await this.requirements.findItem(requirementId, itemId);
    if (!item) {
      throw new NotFoundException('Requirement item not found');
    }
    if (!canManageTestCases(await this.access.findAppRole(userId))) {
      throw testCaseManageForbidden();
    }
    await this.iterations.assertRowWritable(requirement);
    if (requirement.archived_at) {
      throw requirementArchived();
    }
    if (requirement.kind !== 'functional') {
      throw testCasesStoryOnly();
    }
    return { requirement, item, userId };
  }

  private async requireCategory(
    itemId: string,
    categoryId: string,
  ): Promise<void> {
    if (!(await this.testCases.findCategory(itemId, categoryId))) {
      throw new NotFoundException('Test case category not found');
    }
  }

  private async recordEvent(
    scope: StoryScope,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: scope.requirement.workspace_id,
      actorUserId: scope.userId,
      eventCode: TEST_CASES_CHANGED_EVENT,
      message: `QA test cases of "${scope.item.title}" changed`,
      metadata: {
        requirementId: scope.requirement.id,
        deliveryProjectId: scope.requirement.delivery_project_id,
        itemId: scope.item.id,
        ...metadata,
      },
    });
  }
}

function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException(`${field} must not be blank`);
  }
  return trimmed;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === QA_UNIQUE_VIOLATION
  );
}
