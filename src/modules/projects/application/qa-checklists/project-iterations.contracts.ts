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
  how: 'merged' | 'already_in_main';
}

/** GET /delivery-projects/:id/iterations */
export interface ProjectIterationList {
  /** Newest first. */
  iterations: ProjectIteration[];
}

/** GET /delivery-projects/:id/iterations/current */
export interface ProjectIterationCurrent {
  /** The active Iteration, or the last delivered one when none is active. */
  iteration: ProjectIteration;
  /** A lead or admin, and no Iteration is active. */
  canStartNext: boolean;
  /** Per-repository delivery state of a delivered Iteration; empty before phase 2. */
  deliveredRepositories: DeliveredRepository[];
}
