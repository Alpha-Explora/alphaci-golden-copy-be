export interface EnsureProjectLinkInput {
  projectId: string;
  workspaceId: string | null;
  name: string;
  repoFullName: string;
  visibility?: string | null;
  createdBy: string;
  projectStatus: string;
}

export interface ProjectLinkPort {
  getLinkedRepositoryId(projectId: string): Promise<string | null>;
  ensureLink(input: EnsureProjectLinkInput): Promise<string | null>;
}

export const PROJECT_LINK_PORT = Symbol('ProjectLinkPort');
