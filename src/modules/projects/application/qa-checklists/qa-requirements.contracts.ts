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
  permissions: { canManage: boolean; canSetProgress: boolean };
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

export interface RequirementsOverview {
  groups: Array<{
    deliveryProject: { id: string; name: string };
    requirements: RequirementSummary[];
  }>;
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
