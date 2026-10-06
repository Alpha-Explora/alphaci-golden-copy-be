/**
 * Read/approve bridge from Pipelines' stored visual-regression data to the
 * Projects workspace's Visual tab.
 *
 * Pipelines owns the three `workflow.visual_*` tables (they are CI data, fed by
 * the generated pipeline's token-authenticated calls); Projects owns who may
 * look at a repository and who may approve, and builds the image URLs because
 * they carry a project id this context does not know. So the port speaks in
 * repository names and returns facts, never URLs or role decisions:
 *
 *   - `getRun` says which snapshots a run has and whether each has an image;
 *   - `readImage` returns bytes;
 *   - `approve` promotes a run's actual image to the branch baseline.
 *
 * Authorization is the caller's job. Nothing here checks a person.
 */

export type VisualSnapshotStatus = 'passed' | 'changed' | 'new';

export type VisualImageKind = 'baseline' | 'actual' | 'diff';

/** The branch a main baseline is inherited from when main has none of its own. */
export type VisualInheritedFrom = 'uat';

export interface VisualSnapshotBaselineFacts {
  /** Content hash of the baseline image; lets callers cache-bust its URL after a re-approval. */
  sha256: string;
  approvedByLogin: string | null;
  approvedAt: string;
  inheritedFrom: VisualInheritedFrom | null;
}

export interface VisualSnapshotFacts {
  name: string;
  status: VisualSnapshotStatus;
  /** Null when there is no baseline (own or inherited) for this name. */
  baseline: VisualSnapshotBaselineFacts | null;
  hasActual: boolean;
  hasDiff: boolean;
  /**
   * True when the branch baseline is byte-identical to this run's actual
   * image, i.e. someone has already approved it. The run's stored status never
   * changes (it records what that run saw); this is how the tab can show
   * "approved" after the fact.
   */
  approved: boolean;
}

export interface VisualRunFacts {
  branch: string;
  runId: number;
  commitSha: string;
  reportedAt: string;
  browser: string;
  snapshots: VisualSnapshotFacts[];
}

export interface VisualApprovalInput {
  repoFullName: string;
  branch: string;
  runId: number;
  names: string[];
  approvedByUserId: string;
  approvedByLogin: string | null;
}

export interface VisualImageQuery {
  repoFullName: string;
  branch: string;
  kind: VisualImageKind;
  name: string;
  /** Required for `actual` and `diff`; ignored for `baseline`. */
  runId?: number;
}

export interface VisualRegressionPort {
  /**
   * The latest run reported for the branch (or the named run), or null when
   * nothing has been reported. When a run carries several browsers, chromium
   * is preferred (it is the baseline browser), else the first by name.
   */
  getRun(
    repoFullName: string,
    branch: string,
    runId?: number,
  ): Promise<VisualRunFacts | null>;

  /** PNG bytes, or null when there is no such image. */
  readImage(query: VisualImageQuery): Promise<Buffer | null>;

  /**
   * Copies each named snapshot's actual image of the run into the branch's
   * baseline. All-or-nothing: throws a 409 (`VISUAL_NOT_APPROVABLE`) naming
   * every snapshot that is unknown, passing, or has no actual image, and
   * approves nothing in that case. Returns the approved names.
   */
  approve(input: VisualApprovalInput): Promise<string[]>;
}

export const VISUAL_REGRESSION_PORT = Symbol('VisualRegressionPort');
