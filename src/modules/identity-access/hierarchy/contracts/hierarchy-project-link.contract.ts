export interface HierarchyProjectLinkContract {
  projectId: string;
  workspaceId: string;
  name: string;
  repoFullName: string;
  visibility: 'private' | 'public';
  createdBy: string;
  projectStatus: string;
}
