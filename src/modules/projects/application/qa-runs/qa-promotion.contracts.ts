/**
 * API-facing (camelCase) shapes for QA promotion (Slice 6, "Merge to main").
 * Exact contract the frontend is built against in parallel. Kept free of
 * Nest/pg imports, same rule as qa-runs.contracts.ts.
 */

import type {
  DeliveryHow,
  ProjectIteration,
  ProjectIterationStatus,
} from '../qa-checklists/project-iterations.contracts';
import type { QaHeadStatus, QaVerdict } from './qa-runs.contracts';

/**
 * The audit event (and notification code) recorded when a repository's uat is
 * merged to main. One definition: the promotion service writes it, and the
 * team overview reads it to say how far a signed-off run has been promoted.
 */
export const QA_PROMOTION_MERGED_EVENT = 'qa.promotion.merged';

/**
 * DEPRECATED (kept for the frontend that predates Project requirements): one
 * entry per requirement of the Project, each carrying the Project-level
 * result in approvedForHead. Read run / repositories instead.
 */
export interface QaPromotionChecklist {
  id: string;
  name: string;
  /** The run for (project, checklist, uat, headSha) -- null when none exists for this exact commit. */
  runId: string | null;
  /** The run's active sign-off verdict; null when there is no run, or the run is still open. */
  verdict: QaVerdict | null;
  runStatus: 'open' | 'signed_off' | null;
  /** True only when a run exists for this exact commit, is signed off, and its active verdict is APPROVED. */
  approvedForHead: boolean;
}

export interface QaPromotionPullRequestRef {
  number: number;
  url: string;
  headSha: string;
}

/** The latest signed-off Project run and whether it is still current for every repository. */
export interface QaPromotionRun {
  id: string;
  verdict: QaVerdict;
  signedAt: string;
  stale: boolean;
}

export interface QaPromotionStatus {
  qaBranch: string;
  targetBranch: string;
  /** The CURRENT head of THIS repository's qaBranch on GitHub (the branch tip, not a deployed commit). Null when unreadable. */
  headSha: string | null;
  /** 'unfiled' = the repository belongs to no Project, so the gate is blocked (QA_PROJECT_REQUIRED on merge). */
  scope: 'project' | 'unfiled';
  deliveryProject: { id: string; name: string } | null;
  /** The latest signed-off Project run; null when the Project has none. */
  run: QaPromotionRun | null;
  /** Every repository of the Project: the head the run captured vs the head now. */
  repositories: QaHeadStatus[];
  /** Informational: requirements changed after the run was signed off. Never blocks. */
  requirementsChanged: boolean;
  /** Deprecated; see QaPromotionChecklist. */
  checklists: QaPromotionChecklist[];
  /** True only when the latest signed-off Project run is APPROVED and current for every repository. */
  eligible: boolean;
  /** What blocks eligibility, one entry per reason (may be empty when eligible). */
  reasons: string[];
  /** The open uat -> targetBranch pull request, if one exists. */
  pullRequest: QaPromotionPullRequestRef | null;
  /** True when the caller may POST .../merge (lead|admin). */
  canMerge: boolean;
  /** This repository has reached main (merged, or main already held the signed-off head). Stored, so it survives a reload. */
  repositoryDelivered: boolean;
  /** The Project's current Iteration is Delivered: Merge is refused (409 ITERATION_DELIVERED). */
  iterationDelivered: boolean;
  /** The Project's current Iteration; null for an unfiled repository. */
  iteration: {
    id: string;
    number: number;
    status: ProjectIterationStatus;
    deliveredAt: string | null;
  } | null;
  /** Machine-readable twin of `reasons` (additive): e.g. ITERATION_DELIVERED. Empty when none applies. */
  reasonCodes: string[];
}

export interface QaPromotionMergePullRequestRef {
  number: number;
  url: string;
}

/** What happened when the system asked GitHub to merge the promotion pull request. */
export interface QaPromotionMergeResult {
  merged: boolean;
  sha: string | null;
  /** GitHub's own sentence on a refusal, or a success message. */
  message: string;
  pullRequest: QaPromotionMergePullRequestRef | null;
  /**
   * How this repository reached main, when it did: 'merged' by this call, or
   * 'already_in_main' (nothing to merge; recorded as delivered). Absent on a
   * failed or refused merge.
   */
  how?: 'merged' | 'already_in_main';
}

/** One repository's outcome in POST /delivery-projects/:id/promotion/merge-all. */
export interface QaPromotionMergeAllRepositoryResult {
  projectId: string;
  repoFullName: string;
  merged: boolean;
  /** 'merged' when this call merged it; 'already_in_main' when main already held the head; null when it failed. */
  how: DeliveryHow | null;
  /** GitHub's or ALPHACI's sentence; null on a plain success. */
  message: string | null;
}

export interface QaPromotionMergeAllResult {
  repositories: QaPromotionMergeAllRepositoryResult[];
  /** The Iteration is Delivered after this call (by it, or already). */
  delivered: boolean;
  iteration: ProjectIteration;
}
