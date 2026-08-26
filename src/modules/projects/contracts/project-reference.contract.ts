export interface ProjectReferenceContract {
  projectId: string;
  userId: string;
  repoFullName: string;
  repoUrl: string;
  workflowPath: string;
  projectOptions: Record<string, unknown>;
}
