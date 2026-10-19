/**
 * API-facing (camelCase) shapes for Project requirements (docs/design/
 * project-requirements.md, section 2). A requirement is a `qa_checklists` row
 * that belongs to a Project (a hierarchy delivery project); its items are User
 * stories (kind functional) or checklist items (kind system). Kept free of
 * Nest/pg imports, same rule as qa-checklists.contracts.ts.
 */

import type { QaChecklistVerificationType } from './qa-checklists.contracts';

export type QaRequirementKind = 'functional' | 'system';

/** The developer track: set by developers, leads and admins. `done` means ready for QA. */
export type QaProgress = 'todo' | 'in_progress' | 'done';

export const QA_REQUIREMENT_KINDS: readonly QaRequirementKind[] = [
  'functional',
  'system',
];

export const QA_PROGRESS_VALUES: readonly QaProgress[] = [
  'todo',
  'in_progress',
  'done',
];

/** Max items per requirement, enforced at the DTO layer and defensively in the service. */
export const QA_REQUIREMENT_MAX_ITEMS = 200;
/** Most requirements one batch create accepts. */
export const QA_REQUIREMENT_BATCH_MAX = 20;
/** Most test case categories one User story holds. */
export const QA_TEST_CATEGORIES_MAX = 30;
/** Most test cases one category holds. */
export const QA_TEST_CASES_PER_CATEGORY_MAX = 100;

/** Run items per Verification status. */
export interface QaVerificationStatusCounts {
  pending: number;
  passed: number;
  failed: number;
  blocked: number;
  returned_to_dev: number;
}

export interface QaProgressCounts {
  todo: number;
  in_progress: number;
  done: number;
}

/** A "story" when its requirement is functional. */
export interface RequirementItem {
  id: string;
  position: number;
  title: string;
  /** Max 4000 characters. */
  acceptanceCriteria: string | null;
  verificationType: QaChecklistVerificationType;
  testIdentifier: string | null;
  progress: QaProgress;
  progressBy: { id: string; login: string } | null;
  progressAt: string | null;
  rowVersion: number;
  /** Caller-specific: whether the caller may PATCH this item's progress. */
  canSetProgress: boolean;
  /**
   * QA's test cases for this story, by category, in position order. Always
   * empty for a system requirement's items: test cases belong to User stories.
   */
  testCategories: TestCaseCategory[];
}

/** One test case QA wrote under a story. */
export interface TestCase {
  id: string;
  position: number;
  title: string;
  /** Max 2000 characters. */
  expectedResult: string | null;
  rowVersion: number;
}

/** A named group of test cases under one story ("Happy path", "Validation"). */
export interface TestCaseCategory {
  id: string;
  position: number;
  name: string;
  rowVersion: number;
  testCases: TestCase[];
}

/** What every test case write answers: the story's whole set of test cases. */
export interface StoryTestCases {
  itemId: string;
  testCategories: TestCaseCategory[];
}

export interface Requirement {
  id: string;
  kind: QaRequirementKind;
  /** Null for an unassigned legacy system checklist. */
  deliveryProjectId: string | null;
  workspaceId: string;
  name: string;
  description: string | null;
  version: number;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The checklist this one was copied from by the backfill, when it was. */
  legacyChecklistId: string | null;
  items: RequirementItem[];
  progressCounts: QaProgressCounts;
}

export interface QaDeliveryProjectRef {
  id: string;
  name: string;
  groupId: string;
}

export interface RequirementListResult {
  deliveryProject: QaDeliveryProjectRef;
  requirements: Requirement[];
  permissions: {
    canManage: boolean;
    canSetProgress: boolean;
    /** QA and admins write test cases (categories and cases) under stories. */
    canManageTestCases: boolean;
  };
}

export interface RequirementProgressResult {
  item: RequirementItem;
  /** True when at least one "ready for QA" notification was queued. */
  readyForQaNotified: boolean;
}

/** One requirement in the team-level read-only overview. */
export interface RequirementSummary {
  id: string;
  kind: QaRequirementKind;
  name: string;
  itemCount: number;
  progressCounts: QaProgressCounts;
  /** From the newest Project run of the Project; null when it has none. */
  verification: QaVerificationStatusCounts | null;
  latestRunStatus: 'open' | 'signed_off' | null;
  archivedAt: string | null;
}

/** Open defects of a Project's newest run, by severity (a null severity is `unrated`). */
export interface OverviewDefectCounts {
  blocker: number;
  major: number;
  minor: number;
  unrated: number;
}

/** The newest Project run of a Project, as the team overview summarizes it. */
export interface OverviewLatestRun {
  id: string;
  status: 'open' | 'signed_off';
  /** ISO. */
  createdAt: string;
  /** From the run's current (non-superseded) sign-off; null while the run is open. */
  verdict: 'APPROVED' | 'REJECTED' | 'CONDITIONAL' | null;
  /** ISO; null while the run is open. */
  signedOffAt: string | null;
  /** The signer's GitHub login; null while the run is open. */
  signedOffBy: string | null;
}

export interface OverviewProjectCounts {
  /**
   * Size of the `readyForQa` bucket of GET /delivery-projects/:id/qa/my-items,
   * from the same bucketing rule (domain/qa-my-items.rules.ts). Read against
   * the Project's newest run: see the note on QaRequirementsService.overview
   * about when `my-items` can resolve a different run.
   */
  readyForQa: number;
  /** Items of the newest run that are failed, blocked or returned to dev. All zero with no run. */
  openDefects: OverviewDefectCounts;
  /** ACTIVE Project members by kind. Leads and admins are never members. */
  members: { developer: number; qa: number };
}

/**
 * How far a signed-off Project run has been promoted to main. Promotion is per
 * repository while the run is per Project, hence merged / total.
 */
export interface OverviewPromotion {
  /** Repositories recorded as delivered (merged, or already in main) in the current Iteration. */
  mergedRepositories: number;
  /** Repositories of the Project that are linked to an AlphaCI project (the ones that can be promoted). */
  totalRepositories: number;
  /** ISO; newest such merge, null when none. */
  lastMergedAt: string | null;
}

/** The Project's current Iteration, for the overview and Home. */
export interface OverviewIteration {
  number: number;
  status: 'active' | 'delivered';
  /** ISO; null until delivered. */
  deliveredAt: string | null;
}

export interface RequirementsOverviewGroup {
  deliveryProject: { id: string; name: string };
  requirements: RequirementSummary[];
  /** Null when the Project has no Project run. */
  latestRun: OverviewLatestRun | null;
  counts: OverviewProjectCounts;
  /**
   * Null unless `latestRun.status` is `signed_off`. Read from the stored
   * delivery state of the current Iteration (`delivery_json`).
   */
  promotion: OverviewPromotion | null;
  /** The Project's current Iteration; a delivered one means the Project is not ready for production. */
  iteration: OverviewIteration | null;
  /** The caller's own ACTIVE membership of this Project; null for leads, admins and non-members. */
  viewerMembership: 'developer' | 'qa' | null;
}

export interface RequirementsOverview {
  groups: RequirementsOverviewGroup[];
  unassigned: RequirementSummary[];
  permissions: { canManage: boolean };
}

/** Input shape for one item. `position` is implied by array index (create) or append order. */
export interface RequirementItemInput {
  title: string;
  acceptanceCriteria?: string | null;
  verificationType?: QaChecklistVerificationType;
  testIdentifier?: string | null;
}
