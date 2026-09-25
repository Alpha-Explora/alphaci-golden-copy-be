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
