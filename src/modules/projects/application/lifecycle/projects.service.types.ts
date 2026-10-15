// Response shapes (match FE contracts exactly).
// Shared with the application-layer view mappers; keep free of runtime imports.
import type { WorkflowFileMetadata } from '../workflows/index';
import type { DeploymentProvisioningResult } from '#kernel/ports/deployment-runtime.port';
import type { StagedWorkflowFile } from '../workflows/index';
import type { ProvisionedProjectStatus } from '../../infrastructure/projects.repository';
import type { WorkflowHistoryEntry } from '../workflows/index';
import type {
  DeploymentTargetSummary,
  EnvVarMetadata,
} from '#kernel/ports/deployment-runtime.port';
import type { ProjectDashboardSnapshot } from '../../infrastructure/project-dashboard-snapshots.repository';
import type { WorkflowUpdateRequestRecord } from '../../infrastructure/project-workflow-update-requests.repository';

export interface CreateProjectResponse {
  hostAssignmentError?: string;
  /** Set when releases from this repository cannot be signed yet; says what to configure. */
  releaseSigningWarning?: string;
  hostAssignments?: Array<{
    environmentId: string;
    status: 'assigned' | 'failed';
    assignmentId?: string;
    message?: string;
  }>;
  id: string;
  repoFullName: string;
  repoUrl: string;
  status: 'provisioned';
  workflowPath: string;
  workflowFiles: WorkflowFileMetadata[];
  githubCommitSha: string;
  githubCommitUrl: string | null;
  projectTypeId: string;
  workflowRecipeId: string;
  /** Branches provisioning created, so the client shows what happened. */
  branchesCreated: string[];
  additionalWorkflowPaths?: string[];
  secondaryRepoFullName?: string;
  secondaryRepoUrl?: string;
  deploymentProvisioning: DeploymentProvisioningResult;
}

export interface SetupProjectResponse {
  id: string;
  repoFullName: string;
  status: 'provisioned';
  workflowPath: string;
  workflowFiles: WorkflowFileMetadata[];
  githubCommitSha: string;
  githubCommitUrl: string | null;
  deploymentProvisioning: DeploymentProvisioningResult;
  /** Set when releases from this repository cannot be signed yet; says what to configure. */
  releaseSigningWarning?: string;
}

export type { DeploymentProvisioningResult } from '#kernel/ports/deployment-runtime.port';

export interface ProvisionedProject {
  id: string;
  repoFullName: string;
  templateId: string;
  serviceName: string;
  workflowPath: string;
  workflowFiles?: WorkflowFileMetadata[] | null;
  status: ProvisionedProjectStatus;
  githubCommitSha: string | null;
  githubCommitUrl: string | null;
  failureReason: string | null;
  repoUrl?: string | null;
  visibility?: string | null;
  repoShape?: string | null;
  projectTypeId?: string | null;
  workflowRecipeId?: string | null;
  projectOptions?: Record<string, unknown> | null;
  /**
   * Owning workspace (orgs.workspaces.id). For hierarchy-managed repositories
   * this is the GROUP id — the FE Projects screen groups the list by it.
   */
  workspaceId?: string | null;
  /**
   * Viewer-relative: true only when the authenticated user is the actual
   * project creator, not just able to see it via admin/manager visibility.
   * Only populated by `listByUser`-backed reads (currently `listProjects`) —
   * undefined elsewhere (e.g. `findByIdAndUser`-backed reads).
   */
  isOwner?: boolean | undefined;
}

export interface SyncProjectsResponse {
  orphaned: number;
  reachable: number;
  total: number;
}

export interface ReconcileDeletedReposResult {
  /** Total tracked projects fetched for this reconciliation pass. */
  total: number;
  /** Rows actually checked against GitHub — `total` minus `outOfScope`. */
  checked: number;
  /** Rows hard-deleted after a confirmed 404 from GitHub. */
  deleted: number;
  /** Rows left untouched because the GitHub check was inconclusive
   *  (401/403/5xx/network error) — never treated as "confirmed gone". */
  skipped: number;
  /** Rows never checked at all because their repo doesn't belong to the
   *  enforced org — the org-scoped installation token can't reliably tell
   *  "deleted" apart from "not accessible to this token" for those repos
   *  (e.g. projects added via the "import an existing repo" flow, which can
   *  point at a personal account or a different org). See the method doc
   *  on reconcileDeletedRepos() for the full reasoning. */
  outOfScope: number;
}

/**
 * A completed disconnect.
 *
 * Only ever a success. When the GitHub half fails the project is kept and the
 * request fails with 409 carrying the reason, so a refusal can no longer arrive
 * inside a 200 that a caller is free to ignore - which is how two refused
 * deletions were reported to the user as done.
 */
export interface DisconnectProjectResponse {
  ok: true;
  githubRepoDeleted: boolean;
  /** Live Render/Vercel resources deleted; present only when requested. */
  providerResourcesDeleted?: number;
  /**
   * Present only when requested: true if a SonarCloud project was deleted,
   * false if there was none in the managed organization.
   */
  sonarProjectDeleted?: boolean;
}

export interface ProvisionedProjectsResponse {
  items: ProvisionedProject[];
}

export type ProjectOverviewHealthStatus = 'ok' | 'warning' | 'error';

export interface ProjectOverviewResponse {
  project: ProvisionedProject & {
    createdAt: string;
    updatedAt: string;
  };
  workflow: {
    path: string;
    files: WorkflowFileMetadata[];
    stageCount: number;
    history: WorkflowHistoryEntry[];
  };
  deploymentTargets: {
    items: DeploymentTargetSummary[];
    count: number;
  };
  environment: {
    items: EnvVarMetadata[];
    count: number;
    failedCount: number;
  };
  ciAuth: {
    status: 'active' | 'revoked' | 'missing';
    tokenPresent: boolean;
    tokenPrefix: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    revokedAt: string | null;
  };
  health: {
    summary: ProjectOverviewHealthStatus;
    checks: Array<{
      key: string;
      label: string;
      status: ProjectOverviewHealthStatus;
      message: string;
    }>;
  };
  syncSnapshot: {
    enabled: boolean;
    mode: 'local_snapshot';
    latest: ProjectDashboardSnapshot | null;
  };
  capabilities: {
    envProvisioning: boolean;
    workflowSettings: boolean;
    syncSnapshots: boolean;
    ciRunTracking: boolean;
    deploymentHistory: boolean;
    driftDetection: boolean;
  };
  /**
   * The hierarchy.repositories id this project is linked to, or null.
   *
   * Developer assignments hang off hierarchy.repositories, not off
   * provisioned_projects, so without this id the project page has no way to
   * address its own access panel. Null means "no assignment surface for this
   * project" — a personal-workspace project, or one created before the link
   * existed — and the UI hides the entry point rather than guessing a URL.
   */
  hierarchyRepositoryId: string | null;
}

export interface ProjectSyncSnapshotResponse {
  snapshot: ProjectDashboardSnapshot;
  overview: ProjectOverviewResponse;
}

export interface ProjectAuditEventItem {
  id: string;
  eventCode: string;
  message: string;
  actorUserId: string | null;
  actorLogin: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  /** 'project' = a Project-level event shown on every repository of the Project. */
  scope: 'repository' | 'project' | 'github';
}

/**
 * How fresh the GitHub activity in an Audit page is.
 *
 *   ok      synced within the last minute (or just now)
 *   stale   GitHub was too slow for this request (> 3 s); the sync keeps
 *           running in the background and the stored events were returned
 *   failed  GitHub could not be read (no token, revoked sign-in, outage);
 *           the stored events were returned
 *
 * `syncedAt` is the last SUCCESSFUL sync of this repository, or null.
 */
export interface ProjectGithubSyncStatus {
  status: 'ok' | 'stale' | 'failed';
  syncedAt: string | null;
}

export interface ProjectAuditEventsResponse {
  enabled: boolean;
  items: ProjectAuditEventItem[];
  /** Pass as `?before=` to fetch the next (older) page; null on the last page. */
  next: string | null;
  /** Present on the first page while audit recording is on. */
  githubSync?: ProjectGithubSyncStatus;
}

export interface ProjectAuditEventsOptions {
  limit?: number;
  before?: string;
}

export interface WorkflowSettings {
  projectId: string;
  templateId: string;
  projectTypeId: string | null;
  workflowRecipeId: string | null;
  serviceName: string;
  servicePath: string;
  nodeVersion: string;
  packageManager: 'npm';
  coverageThreshold: number;
  centralWorkflowRef: string;
  checks: {
    lint: boolean;
    unit: boolean;
    build: boolean;
    security: boolean;
  };
}

export interface WorkflowSettingsResponse {
  enabled: boolean;
  source: 'stored' | 'project_options';
  settings: WorkflowSettings;
}

export interface WorkflowSettingsPreviewRequest {
  templateId?: string;
  projectTypeId?: string | null;
  workflowRecipeId?: string | null;
  serviceName?: string;
  servicePath?: string;
  nodeVersion?: string;
  packageManager?: 'npm';
  coverageThreshold?: number;
  centralWorkflowRef?: string;
  checks?: Partial<WorkflowSettings['checks']>;
}

export interface WorkflowSettingsPreviewResponse {
  settings: WorkflowSettings;
  workflowFiles: StagedWorkflowFile[];
  diffSummary: Array<{
    path: string;
    status: 'new' | 'changed' | 'unchanged';
  }>;
  validationWarnings: Array<{
    field: string;
    message: string;
  }>;
}

export interface WorkflowUpdatePullRequestResponse {
  projectId: string;
  repoFullName: string;
  branchName: string;
  workflowPath: string;
  workflowFiles: WorkflowFileMetadata[];
  pullRequestNumber: number;
  pullRequestUrl: string;
  status: 'created';
  request: WorkflowUpdateRequestRecord | null;
}

// ─── GitHub Contents API response ────────────────────────────────────────────
