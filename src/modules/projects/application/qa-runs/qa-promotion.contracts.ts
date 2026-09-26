/**
 * API-facing (camelCase) shapes for QA promotion (Slice 6, "Merge to main").
 * Exact contract the frontend is built against in parallel. Kept free of
 * Nest/pg imports, same rule as qa-runs.contracts.ts.
 */

import type { QaVerdict } from './qa-runs.contracts';

/** One checklist shared to the project and whether its run approves the current uat head. */
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

export interface QaPromotionStatus {
  qaBranch: string;
  targetBranch: string;
  /** The CURRENT head of qaBranch on GitHub (the branch tip, not a deployed commit). Null when unreadable. */
  headSha: string | null;
  checklists: QaPromotionChecklist[];
  /** True only when headSha is known, at least one checklist is shared, and every one is approvedForHead. */
  eligible: boolean;
  /** What blocks eligibility, one entry per reason (may be empty when eligible). */
  reasons: string[];
  /** The open uat -> targetBranch pull request, if one exists. */
  pullRequest: QaPromotionPullRequestRef | null;
  /** True when the caller may POST .../merge (lead|admin). */
  canMerge: boolean;
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
}
