/**
 * API-facing (camelCase) shapes for the QA verification runs slice (Slice 3).
 * This is the exact contract the frontend is being built against in
 * parallel — see the task description for the wire shape. Kept free of
 * Nest/pg imports, same rule as qa-checklists.contracts.ts.
 */

import type {
  QaChecklistTargetPersona,
  QaChecklistVerificationType,
} from '../qa-checklists/qa-checklists.contracts';

export type QaRunItemStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'returned_to_dev';

export type QaDefectSeverity = 'blocker' | 'major' | 'minor';

export type QaVerdict = 'APPROVED' | 'REJECTED' | 'CONDITIONAL';

export type QaRunStatus = 'open' | 'signed_off';

export type QaCommitSource = 'deployment' | 'branch_head';

export interface QaActor {
  id: string;
  login: string;
}

export interface QaRunItemFixRequest {
  requestedAt: string;
  requestedBy: QaActor;
  note: string | null;
}

export interface QaRunItemPrevious {
  runId: string;
  commitSha: string;
  status: QaRunItemStatus;
}

/** One tool's stage-level report, folded into the shape the QA runs contract exposes. */
export type QaAutomationStage = 'quality' | 'verify';

export type QaAutomationRunStatus =
  | 'success'
  | 'failure'
  | 'running'
  | 'cancelled';

export interface QaAutomationFailure {
  name: string;
  message: string;
}

export interface QaAutomationTestResults {
  total: number;
  passed: number;
  failed: number;
  /** Capped at the first 20 by the reporting workflow. */
  failures: QaAutomationFailure[];
  /** True when `failed` exceeds `failures.length` — the list is a prefix, not the whole set. */
  failuresTruncated: boolean;
}

/** One CI stage's latest report for the run's (branch, commitSha), read at request time. */
export interface QaStageAutomation {
  stage: QaAutomationStage;
  status: QaAutomationRunStatus;
  runId: number;
  runUrl: string;
  reportedAt: string;
  /** Null when the stage's report carries no test counts. */
  tests: QaAutomationTestResults | null;
}

/** The run's automated evidence, one slot per stage it could come from. */
export interface QaRunAutomation {
  verify: QaStageAutomation | null;
  quality: QaStageAutomation | null;
}

export type QaAutomationSource = 'playwright' | 'unit_test' | 'bruno';

export type QaAutomationItemStatus =
  | 'passed'
  | 'failed'
  | 'unknown'
  | 'not_run';

export type QaAutomationScope = 'spec' | 'suite' | 'stage';

/**
 * One checklist item's automated verdict, matched against QaRunAutomation —
 * see qa-automation-matching.ts for the rules. Null on the item (never this
 * shape itself) means the item's verificationType is 'manual'.
 */
export interface QaAutomatedResult {
  source: QaAutomationSource;
  stage: QaAutomationStage;
  status: QaAutomationItemStatus;
  scope: QaAutomationScope;
  matchedSpec: string | null;
  failure: QaAutomationFailure | null;
  runId: number | null;
  runUrl: string | null;
  reportedAt: string | null;
}

export interface QaRunItem {
  id: string;
  runId: string;
  position: number;
  title: string;
  description: string | null;
  targetPersona: QaChecklistTargetPersona;
  verificationType: QaChecklistVerificationType;
  testIdentifier: string | null;
  status: QaRunItemStatus;
  notes: string | null;
  defectSeverity: QaDefectSeverity | null;
  reproductionSteps: string | null;
  fixRequest: QaRunItemFixRequest | null;
  verifiedBy: QaActor | null;
  verifiedAt: string | null;
  rowVersion: number;
  canUpdate: boolean;
  previous: QaRunItemPrevious | null;
  /** Null for verification_type 'manual'; computed at read time, never stored. */
  automated: QaAutomatedResult | null;
}

export interface QaSignoff {
  id: string;
  verdict: QaVerdict;
  summary: string | null;
  conditions: string | null;
  signedBy: QaActor;
  signedAt: string;
}

export interface QaRunSummaryCounts {
  total: number;
  byStatus: Record<QaRunItemStatus, number>;
  openDefects: number;
  blockers: number;
}

export interface QaRunPermissions {
  canUpdateItems: boolean;
  canReturnToDev: boolean;
  canRequestRetest: boolean;
  canSignOff: boolean;
  canReopen: boolean;
}

export interface QaRunListItem {
  id: string;
  projectId: string;
  /** Null once the checklist was deleted with its workspace; checklistName/Version stay. */
  checklistId: string | null;
  checklistName: string;
  checklistVersion: number;
  branch: string;
  commitSha: string;
  commitSource: QaCommitSource;
  status: QaRunStatus;
  createdBy: QaActor;
  createdAt: string;
  updatedAt: string;
  summary: QaRunSummaryCounts;
  signoff: QaSignoff | null;
}

export interface QaRun extends QaRunListItem {
  items: QaRunItem[];
  permissions: QaRunPermissions;
  /** Computed at read time for (project repo, run.branch, run.commitSha); never stored. */
  automation: QaRunAutomation;
}

export interface QaReturnedItem {
  runId: string;
  branch: string;
  commitSha: string;
  checklistName: string;
  item: QaRunItem;
}

export const QA_RUN_ITEM_STATUSES: readonly QaRunItemStatus[] = [
  'pending',
  'in_progress',
  'passed',
  'failed',
  'blocked',
  'returned_to_dev',
];

export const QA_DEFECT_SEVERITIES: readonly QaDefectSeverity[] = [
  'blocker',
  'major',
  'minor',
];

export const QA_VERDICTS: readonly QaVerdict[] = [
  'APPROVED',
  'REJECTED',
  'CONDITIONAL',
];

/** Statuses that count as an "open defect" in QaRunSummaryCounts. */
export const QA_OPEN_DEFECT_STATUSES: readonly QaRunItemStatus[] = [
  'failed',
  'blocked',
  'returned_to_dev',
];

/** Default and maximum page size for GET .../qa-runs. */
export const QA_RUNS_LIST_DEFAULT_LIMIT = 20;
export const QA_RUNS_LIST_MAX_LIMIT = 100;
