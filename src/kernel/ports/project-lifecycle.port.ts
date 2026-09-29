/**
 * Narrow outbound seam identity-access/hierarchy uses to delete the AlphaCI
 * project behind a hierarchy repository row — reused by
 * DeliveryProjectsService.deleteDeliveryProject so a whole Project (folder)
 * delete can tear down every linked AlphaCI project without hierarchy
 * depending on the projects module directly (see ProjectProvisioningModule,
 * the existing PROJECT_LOOKUP/WORKSPACE_DATA_CLEANUP seams it already
 * carries the same way).
 *
 * `confirmRepoName` is deliberately NOT part of this contract. The concrete
 * adapter (ProjectLifecyclePortAdapter, in the projects module) resolves the
 * project's current repo_full_name itself and forwards it to
 * ProjectLifecycleService.disconnectProject — a caller here never needs to
 * know that GitHub-repo deletion requires a re-validated confirmation
 * string; that is purely an implementation detail of disconnectProject's own
 * contract.
 *
 * Throws NotFoundException (the shared `@nestjs/common` class, not a
 * projects-specific type) only when the project no longer exists — a caller
 * doing a bulk delete across many repositories can catch that with a plain
 * `instanceof NotFoundException` and treat an already-gone project as a
 * successful no-op. A project that exists but the caller cannot delete is a
 * ForbiddenException (code PROJECT_DELETE_FORBIDDEN), never a 404.
 */
export interface ProjectLifecycleDisconnectOptions {
  deleteGithubRepo?: boolean;
  deleteProviderResources?: boolean;
  deleteSonarProject?: boolean;
}

export interface ProjectLifecycleDisconnectResult {
  githubRepoDeleted: boolean;
}

export interface ProjectLifecyclePort {
  disconnectProject(
    projectId: string,
    userId: string,
    options: ProjectLifecycleDisconnectOptions,
    githubAccessToken?: string | null,
  ): Promise<ProjectLifecycleDisconnectResult>;
}

export const PROJECT_LIFECYCLE_PORT = Symbol('ProjectLifecyclePort');
