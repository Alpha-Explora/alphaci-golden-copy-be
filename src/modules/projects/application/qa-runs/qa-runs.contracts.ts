/**
 * API-facing (camelCase) shapes for the QA verification runs slice (Slice 3).
 * This is the exact contract the frontend is being built against in
 * parallel — see the task description for the wire shape. Kept free of
 * Nest/pg imports, same rule as qa-checklists.contracts.ts.
 */

import type { CiTestCase } from '#kernel/ports/ci-stage-results.port';

import type { ProjectIterationRef } from '../qa-checklists/project-iterations.contracts';
import type {
  QaChecklistTargetPersona,
  QaChecklistVerificationType,
} from '../qa-checklists/qa-checklists.contracts';
import type {
  QaVerificationStatusCounts,
  RequirementItem,
} from '../qa-checklists/qa-requirements.contracts';

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

/** Who is calling, plus the session's GitHub OAuth token for the read/write fallback chain. */
export interface QaRunActorContext {
  userId: string;
  userLogin: string;
  oauthToken: string | null;
}

export interface QaRunItemFixRequest {
  requestedAt: string;
  requestedBy: QaActor;
  note: string | null;
}

export interface QaRunItemPrevious {
  runId: string;
  /** Null when the earlier run was a Project run (it covers several repositories). */
  commitSha: string | null;
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
  /**
   * Titles of the tests that passed (see CiStageTestResults.passes). Absent
   * when the pipeline did not report them; the matcher then infers and marks
   * its results `inferred`.
   */
  passes?: string[];
  /** Every test with what it checks and how it ended (see CiTestCase), when reported. */
  cases?: CiTestCase[];
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

/**
 * `unlinked` is a Playwright item with no test identifier: nothing was run FOR
 * it, so it is neither a pass nor a failure. The stage verdict still travels
 * with it (stage, runId, runUrl) as context. Display only, like every other
 * automated status: it never counts as passed or failed and never gates
 * sign-off.
 */
export type QaAutomationItemStatus =
  | 'passed'
  | 'failed'
  | 'unknown'
  | 'not_run'
  | 'unlinked';

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
  /**
   * True when a Playwright 'passed' was INFERRED from the spec's absence in
   * the failure list because the pipeline did not report which tests passed
   * (an older generated workflow). Absent otherwise: a pass backed by a named
   * passing test, or a stage-level verdict, is not inferred.
   */
  inferred?: boolean;
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
  /** Always 'repository': Project-scope runs are ProjectQaRunListItem. */
  scope: 'repository';
  /** Repository-scope runs are read-only history; the write routes answer QA_RUN_LEGACY_READONLY. */
  legacy: true;
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

/** One open, developer-targeted item on the current uat run -- same shape as QaReturnedItem, named for its distinct feed. */
export interface QaDeveloperItem {
  runId: string;
  branch: string;
  commitSha: string;
  checklistName: string;
  item: QaRunItem;
}

/** The Overview "My QA items" card: items returned by QA, plus open developer-targeted items still awaiting work. */
export interface QaMyItems {
  returned: QaReturnedItem[];
  developerItems: QaDeveloperItem[];
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

// ---------------------------------------------------------------------
// Project-scope runs (docs/design/project-requirements.md, section 2.4)
// ---------------------------------------------------------------------

/** The Verification track. New writes never use 'in_progress'. */
export type QaProjectVerificationStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'returned_to_dev';

/** Settable through PATCH on a Project run item: every status except 'in_progress'. */
export const QA_PROJECT_VERIFICATION_STATUSES: readonly QaProjectVerificationStatus[] =
  ['pending', 'passed', 'failed', 'blocked', 'returned_to_dev'];

export type { QaVerificationStatusCounts };

/** One repository of the Project: the head the run captured vs the head now. */
export interface QaHeadStatus {
  projectId: string;
  repoFullName: string;
  /** The uat head captured when the run started; null when no run is being compared. */
  runSha: string | null;
  /** The uat head right now; null when it could not be read. */
  currentSha: string | null;
  /** True when a run exists and this repository's head differs from (or is absent in) it. */
  moved: boolean;
}

export interface ProjectQaRunItem extends QaRunItem {
  /** The requirement item this was snapshotted from; null once that item was deleted. */
  sourceItemId: string | null;
  requirementId: string | null;
  requirementName: string | null;
  requirementKind: 'functional' | 'system' | null;
  acceptanceCriteria: string | null;
  /** The source item's CURRENT Progress (live, not snapshotted); null when the source was deleted. */
  progress: 'todo' | 'in_progress' | 'done' | null;
  /** How many screenshots (of any kind) are attached to this item. */
  attachmentCount: number;
  /**
   * The attachments' ids and captions, no URLs. Present only in the QA report
   * (and so in the report frozen at sign-off); never on a plain run payload.
   */
  attachments?: QaRunItemAttachmentRef[];
  /**
   * QA's test cases for this story in this run, by category, with each
   * result. An open run also lists categories that hold no test case yet.
   * Absent on reports frozen before test cases existed.
   */
  testCategories?: ProjectQaRunTestCategory[];
}

/** A test case's result in one run. 'not_applicable' counts as resolved, like 'passed'. */
export type QaTestCaseStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'not_applicable';

export const QA_TEST_CASE_STATUSES: readonly QaTestCaseStatus[] = [
  'pending',
  'passed',
  'failed',
  'blocked',
  'not_applicable',
];

/** Results that keep a story from passing (and a run from an APPROVED sign-off). */
export const QA_OPEN_TEST_CASE_STATUSES: readonly QaTestCaseStatus[] = [
  'pending',
  'failed',
  'blocked',
];

/** One test case as tested in one Project run. */
export interface ProjectQaRunTestCase {
  id: string;
  /** The test case definition; null once it was deleted (signed-off runs keep their copy). */
  sourceTestCaseId: string | null;
  position: number;
  title: string;
  expectedResult: string | null;
  status: QaTestCaseStatus;
  notes: string | null;
  verifiedBy: QaActor | null;
  verifiedAt: string | null;
  rowVersion: number;
  /**
   * The definition's row_version, for editing it from the run (open runs
   * only; null on a signed-off run or once the definition was deleted).
   */
  definitionRowVersion: number | null;
}

export interface ProjectQaRunTestCategory {
  /** The category definition; null once it was deleted. */
  id: string | null;
  name: string;
  /** The definition's row_version, for renaming it from the run (open runs only). */
  rowVersion: number | null;
  testCases: ProjectQaRunTestCase[];
}

export type QaAttachmentKind = 'evidence' | 'fix_proof' | 'automated';

export type QaAttachmentSource = 'capture' | 'paste' | 'upload' | 'playwright';

export type QaAttachmentContentTypeName =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp';

/** An attachment as the QA report carries it: stable identity, no URL (signed URLs expire). */
export interface QaRunItemAttachmentRef {
  id: string;
  caption: string | null;
  kind: QaAttachmentKind;
  contentType: QaAttachmentContentTypeName;
}

/** An attachment as the attachment routes return it. */
export interface QaAttachment {
  id: string;
  runId: string;
  runItemId: string;
  kind: QaAttachmentKind;
  contentType: QaAttachmentContentTypeName;
  byteSize: number;
  width: number;
  height: number;
  caption: string | null;
  source: QaAttachmentSource;
  /** Automated attachments: the Playwright test the image came from. */
  testTitle: string | null;
  /** Null for automated attachments. */
  createdByLogin: string | null;
  createdAt: string;
  /** Storage signed URL, valid for 5 minutes. */
  url: string;
  urlExpiresAt: string;
  /** The caller may delete it: the uploader, or a lead/admin, of a human attachment on an open run. */
  canDelete: boolean;
}

export interface QaAttachmentList {
  items: QaAttachment[];
}

/** Run-level switch the UI keys its attach controls on. */
export interface QaRunAttachmentsState {
  /** False when screenshot storage is not configured: hide the controls. */
  enabled: boolean;
  /** The caller may add evidence (qa, lead or admin) and the run is open. */
  canAdd: boolean;
}

export interface ProjectQaRunPermissions {
  canSetVerification: boolean;
  canSignOff: boolean;
  canReopen: boolean;
  canDispatch: boolean;
  /** The run is open and the caller is QA or an admin: may add, edit and delete test cases. */
  canManageTestCases: boolean;
}

export interface ProjectQaRunListItem {
  id: string;
  scope: 'project';
  deliveryProjectId: string;
  deliveryProjectName: string;
  /** The Iteration this run belongs to. Absent on reports frozen before Iterations existed. */
  iteration?: ProjectIterationRef | null;
  branch: string;
  status: QaRunStatus;
  createdBy: QaActor;
  createdAt: string;
  updatedAt: string;
  summary: QaRunSummaryCounts;
  signoff: QaSignoff | null;
}

export interface ProjectQaRun extends ProjectQaRunListItem {
  /** One entry per repository the run covers (or covers now), with its captured and current head. */
  repositories: QaHeadStatus[];
  /** Any covered repository moved since the run, or a repository joined the Project. */
  stale: boolean;
  /** Informational: requirements were created, edited, archived or reordered after the run started (open) or was signed off. */
  requirementsChanged: boolean;
  items: ProjectQaRunItem[];
  permissions: ProjectQaRunPermissions;
  attachments: QaRunAttachmentsState;
  /** First report per stage across the covered repositories. */
  automation: QaRunAutomation;
  automationByRepository: Array<{
    projectId: string;
    repoFullName: string;
    automation: QaRunAutomation;
  }>;
}

export interface ProjectQaCurrentRun {
  run: ProjectQaRun | null;
  heads: QaHeadStatus[];
  stale: boolean;
}

export interface QaProjectRunsPage {
  runs: ProjectQaRunListItem[];
  next: string | null;
}

/** One requirement item on the project-wide My QA items feed. */
export interface QaMyItemsFeedItem {
  requirement: {
    id: string;
    name: string;
    kind: 'functional' | 'system';
  };
  item: RequirementItem;
  runId: string | null;
  runItem: ProjectQaRunItem | null;
}

export interface ProjectMyQaItems {
  /** The current run item is returned_to_dev. */
  returned: QaMyItemsFeedItem[];
  /** Progress is in_progress (and not returned). */
  inProgress: QaMyItemsFeedItem[];
  /** Progress is todo (and not returned). */
  todo: QaMyItemsFeedItem[];
  /** Progress is done and the run item is still pending (or no run exists yet): QA's queue. */
  readyForQa: QaMyItemsFeedItem[];
}

export const QA_PROJECT_RUN_BRANCH = 'uat';
