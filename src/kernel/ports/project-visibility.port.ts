/**
 * Read-only bridge exposing Projects' role-aware project visibility rule
 * (see projectVisibilitySql in projects.repository.ts: global admin, owner,
 * active workspace member, or an assigned hierarchy repository) to other
 * bounded contexts that key a lookup on repoFullName rather than a project
 * id.
 *
 * First consumer: Pipelines' CI reports service (GET /ci/runs), whose
 * ownership check was previously owner-only — see the port's usage for why
 * a plain module import cannot do this instead: Projects already imports
 * Pipelines (for CiService), so Pipelines importing Projects back would be
 * a cross-context cycle. Bound globally by ProjectVisibilityModule instead,
 * the same shape as DEPLOYMENT_PROJECT_REFERENCE_LOOKUP in
 * deployment-runtime.port.ts / project-reference.module.ts.
 */

export interface ProjectVisibilityLookup {
  /** True when `userId` may see the project whose repository is `repoFullName`. */
  isRepoVisibleToUser(repoFullName: string, userId: string): Promise<boolean>;
  /**
   * Lower-cased repo_full_name of every provisioned project `userId` may see,
   * optionally narrowed to one workspace (team). Backs the unscoped
   * GET /ci/runs, which used to filter on the ingest-time project owner.
   */
  listVisibleRepoNames(userId: string, workspaceId?: string): Promise<string[]>;
}

export const PROJECT_VISIBILITY_LOOKUP = Symbol('ProjectVisibilityLookup');
