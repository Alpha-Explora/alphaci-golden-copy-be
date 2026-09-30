export interface EnsureProjectLinkInput {
  projectId: string;
  workspaceId: string | null;
  name: string;
  /**
   * Name for a newly auto-created system/delivery-project chain. Falls back
   * to `name` when omitted, which is exactly today's standalone behavior.
   * Used by the multi-repo/microservices pair so the SHARED chain is named
   * after the base repo, while each row's own `name` still names its own
   * hierarchy.repositories entry.
   */
  chainName?: string;
  repoFullName: string;
  visibility?: string | null;
  createdBy: string;
  projectStatus: string;
  /**
   * Link into this EXISTING delivery project instead of auto-creating a new
   * system/delivery-project chain. Only the hierarchy.repositories row is
   * inserted. Must already be validated by the caller (see
   * `assertDeliveryProjectAvailableForCreate`) — this is still re-checked
   * here, defensively, but that check is best-effort (logs and no-ops on
   * failure) rather than the user-facing 400/404/403 the up-front gate gives.
   */
  deliveryProjectId?: string;
}

export interface EnsureLinkResult {
  repositoryId: string;
  deliveryProjectId: string;
}

/** The delivery project ("Project" folder) a repository project is filed under. */
export interface ProjectFolderLink {
  deliveryProjectId: string;
  groupId: string;
  name: string;
  /** Non-archived repository rows of the delivery project, oldest first. */
  repositories: Array<{
    /** Null when the repository row is not linked to an AlphaCI project. */
    projectId: string | null;
    name: string;
    repoFullName: string | null;
  }>;
}

export interface ProjectLinkPort {
  getLinkedRepositoryId(projectId: string): Promise<string | null>;
  /**
   * The delivery project this project is filed under with its sibling
   * repositories, or null when the project has no hierarchy row. Unlike
   * getLinkedRepositoryId this lets a database failure propagate.
   */
  getProjectFolder(projectId: string): Promise<ProjectFolderLink | null>;
  ensureLink(input: EnsureProjectLinkInput): Promise<EnsureLinkResult | null>;
  /**
   * User-facing gate for a caller-supplied `deliveryProjectId` on project
   * creation. Must run BEFORE any GitHub call — a late rejection would strand
   * a real repository. Throws NotFoundException/ForbiddenException/
   * BadRequestException; never returns a false/failure value.
   */
  assertDeliveryProjectAvailableForCreate(input: {
    deliveryProjectId: string;
    workspaceId: string;
    userId: string;
  }): Promise<void>;
}

export const PROJECT_LINK_PORT = Symbol('ProjectLinkPort');
