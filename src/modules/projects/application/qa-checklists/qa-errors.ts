import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

/**
 * Coded errors for Project requirements and Project QA runs. One place so
 * every path answers identically and the frontend can switch on `code`. Shape:
 * `{ statusCode, error, code, message, ...extra }`, the same as
 * kernel/rules/persona-access.errors.ts.
 */

function body(
  statusCode: number,
  error: string,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return { statusCode, error, code, message, ...extra };
}

export const requirementKindInvalid = () =>
  new BadRequestException(
    body(
      400,
      'Bad Request',
      'REQUIREMENT_KIND_INVALID',
      'A requirement is either "functional" or "system".',
    ),
  );

export const requirementOrderMismatch = () =>
  new BadRequestException(
    body(
      400,
      'Bad Request',
      'REQUIREMENT_ORDER_MISMATCH',
      "itemIds must be exactly the requirement's current items, each once.",
    ),
  );

export const verificationStatusInvalid = (status: string) =>
  new BadRequestException(
    body(
      400,
      'Bad Request',
      'QA_VERIFICATION_STATUS_INVALID',
      `"${status}" is not a Verification status. Use pending, passed or failed (failed sends it back to the Developers).`,
    ),
  );

export const requirementManageForbidden = () =>
  new ForbiddenException(
    body(
      403,
      'Forbidden',
      'REQUIREMENT_MANAGE_FORBIDDEN',
      'Product owners create and edit requirements.',
    ),
  );

export const progressForbidden = () =>
  new ForbiddenException(
    body(
      403,
      'Forbidden',
      'PROGRESS_FORBIDDEN',
      'Developers set Progress; QA verifies.',
    ),
  );

export const verificationForbidden = () =>
  new ForbiddenException(
    body(
      403,
      'Forbidden',
      'VERIFICATION_FORBIDDEN',
      'QA verifies; developers report Progress.',
    ),
  );

/** `index` (0-based) is set by the batch create: which entry collided. */
export const requirementNameTaken = (name: string, index?: number) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'REQUIREMENT_NAME_TAKEN',
      `A requirement named "${name}" already exists in this Project.`,
      index === undefined ? {} : { index },
    ),
  );

export const requirementBatchInvalid = (max: number) =>
  new BadRequestException(
    body(
      400,
      'Bad Request',
      'REQUIREMENT_BATCH_INVALID',
      `A batch holds between 1 and ${max} requirements.`,
    ),
  );

export const requirementBatchDuplicateName = (name: string, index: number) =>
  new BadRequestException(
    body(
      400,
      'Bad Request',
      'REQUIREMENT_BATCH_DUPLICATE_NAME',
      `"${name}" appears more than once in this batch.`,
      { index },
    ),
  );

export const requirementStale = (expected: number, current: number) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'REQUIREMENT_STALE',
      `This requirement has changed (expected version ${expected}, current version ${current}); reload and try again.`,
    ),
  );

export const requirementItemStale = (expected: number) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'REQUIREMENT_ITEM_STALE',
      `This item has changed (expected row version ${expected}); reload and try again.`,
    ),
  );

export const requirementArchived = () =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'REQUIREMENT_ARCHIVED',
      'This requirement is archived.',
    ),
  );

export const requirementMovedToProject = (deliveryProjectId: string) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'REQUIREMENT_MOVED_TO_PROJECT',
      'This checklist now belongs to a Project. Edit it through the Project requirements.',
      { deliveryProjectId },
    ),
  );

export const qaNoRequirements = () =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_NO_REQUIREMENTS',
      'This Project has no QA requirements to verify.',
    ),
  );

export const qaNoRepositories = () =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_NO_REPOSITORIES',
      'This Project has no repository to verify.',
    ),
  );

export const qaUatBranchMissing = (repositories: string[]) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_UAT_BRANCH_MISSING',
      'Some repositories have no uat branch yet.',
      { reasons: repositories.map((name) => `"${name}" has no uat branch`) },
    ),
  );

export const qaUatHeadUnreadable = (repositories: string[]) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_UAT_HEAD_UNREADABLE',
      'The uat head of some repositories could not be read.',
      {
        reasons: repositories.map(
          (name) => `Could not read the uat head of "${name}"`,
        ),
      },
    ),
  );

export const qaProgressNotDone = () =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_PROGRESS_NOT_DONE',
      'A developer marks this Done before QA can pass it.',
    ),
  );

export const qaRunLegacyReadonly = (projectRunsUrl: string | null) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_RUN_LEGACY_READONLY',
      'Repository-level QA runs are read-only history. QA now verifies once per Project.',
      { projectRunsUrl },
    ),
  );

export const qaProjectRequired = () =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_PROJECT_REQUIRED',
      'This repository is not filed under a Project; QA requirements belong to Projects.',
    ),
  );

// ---------------------------------------------------------------------
// Attachments (screenshots on a Project run item)
// ---------------------------------------------------------------------

export const qaRunSignedOff = () =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_RUN_SIGNED_OFF',
      'This run is signed off. Reopen it to make changes.',
    ),
  );

export const qaAttachmentLimit = (max: number) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_ATTACHMENT_LIMIT',
      `An item holds at most ${max} screenshots. Remove one to add another.`,
      { max },
    ),
  );

export const qaAttachmentTooLarge = (message: string) =>
  new PayloadTooLargeException(
    body(413, 'Payload Too Large', 'QA_ATTACHMENT_TOO_LARGE', message),
  );

export const qaAttachmentType = () =>
  new UnsupportedMediaTypeException(
    body(
      415,
      'Unsupported Media Type',
      'QA_ATTACHMENT_TYPE',
      'Only PNG, JPEG and WebP images can be attached.',
    ),
  );

export const qaAttachmentForbidden = (message: string) =>
  new ForbiddenException(
    body(403, 'Forbidden', 'QA_ATTACHMENT_FORBIDDEN', message),
  );

export const qaAttachmentKind = () =>
  new BadRequestException(
    body(
      400,
      'Bad Request',
      'QA_ATTACHMENT_KIND',
      'Only kind "evidence" can be attached for now.',
    ),
  );

export const qaAttachmentsUnavailable = () =>
  new ServiceUnavailableException(
    body(
      503,
      'Service Unavailable',
      'QA_ATTACHMENTS_UNAVAILABLE',
      'Screenshot storage is not configured.',
    ),
  );

// ---------------------------------------------------------------------
// Test cases (categories and cases under a User story)
// ---------------------------------------------------------------------

export const testCaseManageForbidden = () =>
  new ForbiddenException(
    body(
      403,
      'Forbidden',
      'TEST_CASE_MANAGE_FORBIDDEN',
      'The QA Team writes test cases.',
    ),
  );

export const testCasesStoryOnly = () =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'TEST_CASES_STORY_ONLY',
      'Test cases belong to User stories of a Feature, not to System requirement items.',
    ),
  );

export const testCategoryNameTaken = (name: string) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'TEST_CATEGORY_NAME_TAKEN',
      `This story already has a test case category named "${name}".`,
    ),
  );

export const testCasesLimit = (message: string) =>
  new ConflictException(body(409, 'Conflict', 'TEST_CASES_LIMIT', message));

export const testCaseStale = (expected: number) =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'TEST_CASE_STALE',
      `This test case has changed (expected row version ${expected}); reload and try again.`,
    ),
  );

/** A story cannot pass, or a run be APPROVED, while test cases are open. */
export const qaTestCasesOpen = (open: number, scope: 'item' | 'run') =>
  new ConflictException(
    body(
      409,
      'Conflict',
      'QA_TEST_CASES_OPEN',
      scope === 'item'
        ? `${open} test case${open === 1 ? ' is' : 's are'} still pending, failed or blocked. Pass them (or mark them not applicable) before passing the story.`
        : `${open} test case${open === 1 ? ' is' : 's are'} still pending, failed or blocked. An APPROVED sign-off needs every test case passed or not applicable.`,
      { openTestCases: open },
    ),
  );
