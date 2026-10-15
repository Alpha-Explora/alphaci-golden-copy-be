import type {
  QaProgress,
  QaRequirementKind,
} from './qa-requirements.contracts';

export type ProjectIterationStatus = 'active' | 'delivered';

/** The slice of an Iteration that rides along on run payloads. */
export interface ProjectIterationRef {
  id: string;
  number: number;
  status: ProjectIterationStatus;
}

export interface ProjectIteration extends ProjectIterationRef {
  deliveryProjectId: string;
  /** Optional, at most 120 characters. */
  goal: string | null;
  startedAt: string;
  startedBy: { id: string | null; login: string | null } | null;
  deliveredAt: string | null;
  deliveredBy: { id: string | null; login: string | null } | null;
  /** The APPROVED run that was delivered; null until delivered. */
  signoffRunId: string | null;
}

/** One repository's delivery state, read from the stored `delivery_json`. */
export interface DeliveredRepository {
  projectId: string;
  repoFullName: string;
  uatHeadSha: string;
  mergeSha: string | null;
  prNumber: number | null;
  how: DeliveryHow;
  /** ISO; when this repository was recorded as delivered. */
  at: string;
}

/** How a repository's main came to contain the signed-off uat head. */
export type DeliveryHow = 'merged' | 'already_in_main';

/**
 * The shape stored in `project_iterations.delivery_json`:
 * `{ repositories: [...] }`, written incrementally while the Iteration is
 * still active and frozen when it is delivered.
 */
export interface IterationDeliveryJson {
  repositories: DeliveredRepository[];
}

/** One repository the delivering run covered, and whether it has reached main. */
export interface CoveredRepository {
  projectId: string;
  repoFullName: string;
  delivered: boolean;
  how: DeliveryHow | null;
}

/** GET /delivery-projects/:id/iterations */
export interface ProjectIterationList {
  /** Newest first. */
  iterations: ProjectIteration[];
}

/** What the Iterations service itself knows; the delivery service adds the rest. */
export interface ProjectIterationCurrentBase {
  iteration: ProjectIteration;
  canStartNext: boolean;
  deliveredRepositories: DeliveredRepository[];
}

/** GET /delivery-projects/:id/iterations/current */
export interface ProjectIterationCurrent extends ProjectIterationCurrentBase {
  /** The active Iteration, or the last delivered one when none is active. */
  iteration: ProjectIteration;
  /** A lead or admin, and no Iteration is active. */
  canStartNext: boolean;
  /** Per-repository delivery state from `delivery_json`, while active and once delivered. */
  deliveredRepositories: DeliveredRepository[];
  /** The repositories of the latest APPROVED, signed-off run; empty until there is one. */
  coveredRepositories: CoveredRepository[];
  /** Lead or admin, the Iteration is active and the Merge to main gate is eligible. */
  canMergeAll: boolean;
  /** Only when `canStartNext`: the delivered Iteration's items, unfinished ones suggested. */
  carryOver?: CarryOverCandidates;
}

/** The Verification status a run item can hold (qa_run_items.status). */
export type CarryOverLastStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'returned_to_dev';

/** One delivered item that can be carried into the next Iteration. */
export interface CarryOverItem {
  id: string;
  title: string;
  progress: QaProgress;
  /** Its Verification status in the delivering run; null when it was not in that run. */
  lastStatus: CarryOverLastStatus | null;
  /** Unfinished: pre-selected in the Start dialog. */
  suggested: boolean;
}

export interface CarryOverRequirement {
  requirementId: string;
  name: string;
  kind: QaRequirementKind;
  items: CarryOverItem[];
}

/** What the Start dialog offers: the latest delivered Iteration's items. */
export interface CarryOverCandidates {
  fromIterationNumber: number;
  requirements: CarryOverRequirement[];
}

/** POST /delivery-projects/:id/iterations */
export interface StartedIteration {
  iteration: ProjectIteration;
  carriedRequirements: number;
  carriedItems: number;
}
