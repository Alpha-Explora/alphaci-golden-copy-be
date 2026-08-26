export interface CreateHierarchyManagedProjectInput {
  userId: string;
  repoFullName: string;
  serviceName: string;
  repoUrl: string;
  workspaceId: string;
}

export interface ProjectLookupPort {
  createHierarchyManagedProject(
    input: CreateHierarchyManagedProjectInput,
  ): Promise<{ id: string }>;
}

export const PROJECT_LOOKUP = Symbol('PROJECT_LOOKUP');
