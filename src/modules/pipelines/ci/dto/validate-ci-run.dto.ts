export interface ValidateCiRunDto {
  repo: string;
  stage: string;
  workflowRunId?: string;
  headSha?: string;
}
