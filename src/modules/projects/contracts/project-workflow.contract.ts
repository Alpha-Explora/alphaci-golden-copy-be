export interface ProjectWorkflowContract {
  projectId: string;
  templateId: string;
  serviceName: string;
  outputFileName: string;
  files: Array<{ path: string; name: string; stage: string; gated: boolean }>;
}
