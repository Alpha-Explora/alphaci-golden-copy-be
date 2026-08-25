/** Deployment-owned drift vocabulary. Project-facing names remain stable. */
export type {
  DeploymentDriftFinding as ProjectDriftFinding,
  DeploymentDriftFindingInput as ProjectDriftFindingInput,
  DeploymentDriftResponse as ProjectDriftResponse,
  DeploymentDriftSeverity as ProjectDriftSeverity,
  DeploymentDriftSource as ProjectDriftSource,
  DeploymentDriftStatus as ProjectDriftStatus,
} from '../core/deployment-provisioning.contract';

export type ProjectDriftRepairAction =
  | 'regenerate_workflow_preview'
  | 'create_workflow_update_pr'
  | 'rotate_ci_token'
  | 'detach_target'
  | 'mark_ignored';

export interface ProjectDriftRepairResponse {
  enabled: boolean;
  mode: 'local_safe';
  findingId: string;
  action: ProjectDriftRepairAction;
  status: 'completed' | 'disabled';
  message: string;
  result?: Record<string, unknown>;
}
