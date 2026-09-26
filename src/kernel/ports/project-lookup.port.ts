export interface CreateHierarchyManagedProjectInput {
  userId: string;
  repoFullName: string;
  serviceName: string;
  repoUrl: string;
  workspaceId: string;
}

/**
 * What a repository is for inside its project, derived by Projects from the
 * declared stack and repository shape, never from the repository's name.
 * `app` covers a standalone or monorepo project and anything unclassified.
 */
export type WorkspaceProjectRole = 'frontend' | 'backend' | 'service' | 'app';

export interface WorkspaceProjectSummary {
  id: string;
  name: string;
  repoFullName: string | null;
  role: WorkspaceProjectRole;
  status: string;
  repoShape: string | null;
}

export interface ProjectLookupPort {
  createHierarchyManagedProject(
    input: CreateHierarchyManagedProjectInput,
  ): Promise<{ id: string }>;
  /** Every provisioned project owned by one workspace, oldest first. */
  listWorkspaceProjects(
    workspaceId: string,
  ): Promise<WorkspaceProjectSummary[]>;
}

export const PROJECT_LOOKUP = Symbol('PROJECT_LOOKUP');
