import type { WorkflowFileMetadata } from '../workflows/index';

export type CiRunStage =
  | 'access_gate'
  | 'quality'
  | 'package'
  | 'deploy_render'
  | 'deploy_vercel'
  | 'unknown';

export type CiRunStatus = 'queued' | 'in_progress' | 'completed';
export type CiRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | null;

export interface ProjectCiRun {
  id: string;
  stage: CiRunStage;
  workflowName: string;
  branch: string;
  commitSha: string | null;
  actor: string;
  status: CiRunStatus;
  conclusion: CiRunConclusion;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  canRerun: boolean;
}

export interface CiRunsProjectContext {
  projectId: string;
  repoFullName: string;
  workflowFiles: Array<Pick<WorkflowFileMetadata, 'name' | 'path'>>;
}

export interface CiRunsProvider {
  listRuns(context: CiRunsProjectContext): Promise<ProjectCiRun[]>;
  getRun(
    context: CiRunsProjectContext,
    runId: string,
  ): Promise<ProjectCiRun | null>;
}
