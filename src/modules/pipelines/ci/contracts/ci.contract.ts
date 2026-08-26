export type CiRunStatusContract =
  | 'queued'
  | 'in_progress'
  | 'success'
  | 'failure';

export interface CiRunContract {
  id: string;
  projectId: string;
  commitSha: string;
  status: CiRunStatusContract;
  startedAt: string | null;
  completedAt: string | null;
}
