import type { ProjectTokenStatus } from '#kernel/ports/ci-project.port';
import type {
  StagedWorkflowFile,
  WorkflowFileMetadata,
} from '../workflows/index';
import type {
  DeploymentTargetSummary,
  EnvVarMetadata,
} from '#kernel/ports/deployment-runtime.port';
import type { ProjectDashboardSnapshotFinding } from '../../infrastructure/project-dashboard-snapshots.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type {
  ProvisionedProject,
  ProjectOverviewHealthStatus,
  ProjectOverviewResponse,
} from '../lifecycle/projects.service.types';

type OverviewHealthCheck = ProjectOverviewResponse['health']['checks'][number];

export function buildLocalSnapshotFindings(
  overview: ProjectOverviewResponse,
): ProjectDashboardSnapshotFinding[] {
  const findings: ProjectDashboardSnapshotFinding[] = [];

  if (overview.workflow.stageCount === 0) {
    findings.push({
      code: 'workflow_files_missing',
      severity: 'warning',
      message: 'No workflow file metadata is tracked yet.',
      source: 'local_snapshot',
    });
  }

  if (overview.deploymentTargets.count === 0) {
    findings.push({
      code: 'deployment_target_not_provisioned',
      severity: 'warning',
      message: 'No deployment targets are configured.',
      source: 'local_snapshot',
    });
  }

  if (overview.ciAuth.status === 'missing') {
    findings.push({
      code: 'ci_token_missing',
      severity: 'warning',
      message: 'No project CI token is tracked.',
      source: 'local_snapshot',
    });
  }

  if (overview.ciAuth.status === 'revoked') {
    findings.push({
      code: 'ci_token_revoked',
      severity: 'warning',
      message: 'Project CI token is revoked.',
      source: 'local_snapshot',
    });
  }

  if (overview.environment.count === 0) {
    findings.push({
      code: 'env_metadata_empty',
      severity: 'warning',
      message: 'No env var metadata is tracked yet.',
      source: 'local_snapshot',
    });
  }

  for (const check of overview.health.checks) {
    if (check.status === 'error') {
      findings.push({
        code: check.key,
        severity: 'error',
        message: check.message,
        source: 'local_snapshot',
      });
    }
  }

  return findings;
}

export function toCiAuthOverview(token: ProjectTokenStatus | null): {
  status: 'active' | 'revoked' | 'missing';
  tokenPresent: boolean;
  tokenPrefix: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  revokedAt: string | null;
} {
  if (!token) {
    return {
      status: 'missing',
      tokenPresent: false,
      tokenPrefix: null,
      createdAt: null,
      updatedAt: null,
      revokedAt: null,
    };
  }

  return {
    status: token.status,
    tokenPresent: true,
    tokenPrefix: token.tokenPrefix,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
    revokedAt: token.revokedAt,
  };
}

function checkProjectStatus(project: ProvisionedProject): OverviewHealthCheck {
  return {
    key: 'project_status',
    label: 'Project status',
    status: project.status === 'failed' ? 'error' : 'ok',
    message:
      project.status === 'failed'
        ? (project.failureReason ?? 'Project provisioning failed.')
        : `Project is ${project.status}.`,
  };
}

function checkWorkflowBundle(
  workflowFiles: WorkflowFileMetadata[],
): OverviewHealthCheck {
  return {
    key: 'workflow_bundle',
    label: 'Workflow bundle',
    status: workflowFiles.length > 0 ? 'ok' : 'warning',
    message:
      workflowFiles.length > 0
        ? `${workflowFiles.length} workflow file${workflowFiles.length === 1 ? '' : 's'} tracked.`
        : 'No workflow file metadata is tracked yet.',
  };
}

function checkCiToken(
  ciAuth: ProjectOverviewResponse['ciAuth'],
): OverviewHealthCheck {
  return {
    key: 'ci_token',
    label: 'CI token',
    status: ciAuth.status === 'active' ? 'ok' : 'warning',
    message:
      ciAuth.status === 'active'
        ? 'Project CI token is active.'
        : ciAuth.status === 'revoked'
          ? 'Project CI token is revoked.'
          : 'No project CI token is tracked.',
  };
}

function checkDeploymentTargets(
  deploymentTargets: DeploymentTargetSummary[],
): OverviewHealthCheck {
  return {
    key: 'deployment_targets',
    label: 'Deployment targets',
    status: deploymentTargets.length > 0 ? 'ok' : 'warning',
    message:
      deploymentTargets.length > 0
        ? `${deploymentTargets.length} deployment target${deploymentTargets.length === 1 ? '' : 's'} tracked.`
        : 'No deployment targets are configured.',
  };
}

function checkEnvMetadata(envMetadata: EnvVarMetadata[]): OverviewHealthCheck {
  return {
    key: 'env_metadata',
    label: 'Environment metadata',
    status: envMetadata.some((item) => item.status === 'failed')
      ? 'warning'
      : 'ok',
    message:
      envMetadata.length > 0
        ? `${envMetadata.length} env var key${envMetadata.length === 1 ? '' : 's'} tracked.`
        : 'No env var metadata is tracked yet.',
  };
}

function summaryFromChecks(
  checks: OverviewHealthCheck[],
): ProjectOverviewHealthStatus {
  return checks.some((check) => check.status === 'error')
    ? 'error'
    : checks.some((check) => check.status === 'warning')
      ? 'warning'
      : 'ok';
}

export function buildOverviewHealth(input: {
  project: ProvisionedProject;
  workflowFiles: WorkflowFileMetadata[];
  ciAuth: ProjectOverviewResponse['ciAuth'];
  deploymentTargets: DeploymentTargetSummary[];
  envMetadata: EnvVarMetadata[];
}): ProjectOverviewResponse['health'] {
  const checks: OverviewHealthCheck[] = [
    checkProjectStatus(input.project),
    checkWorkflowBundle(input.workflowFiles),
    checkCiToken(input.ciAuth),
    checkDeploymentTargets(input.deploymentTargets),
    checkEnvMetadata(input.envMetadata),
  ];

  return { summary: summaryFromChecks(checks), checks };
}

export function toProvisionedProject(
  row: ProvisionedProjectRow,
): ProvisionedProject {
  const workflowFiles = Array.isArray(row.project_options?.['workflowFiles'])
    ? (row.project_options['workflowFiles'] as WorkflowFileMetadata[])
    : null;

  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    templateId: row.template_id,
    serviceName: row.service_name,
    workflowPath: row.workflow_path,
    workflowFiles,
    status: row.status,
    githubCommitSha: row.github_commit_sha,
    githubCommitUrl: row.github_commit_url,
    failureReason: row.failure_reason,
    repoUrl: row.repo_url,
    visibility: row.visibility,
    repoShape: row.repo_shape,
    projectTypeId: row.project_type_id,
    workflowRecipeId: row.workflow_recipe_id,
    projectOptions: row.project_options,
    workspaceId: row.workspace_id ?? null,
    isOwner: row.is_owner,
  };
}

export function workflowFileMetadata(
  workflowFiles: StagedWorkflowFile[],
): WorkflowFileMetadata[] {
  return workflowFiles.map((file) => ({
    stage: file.stage,
    name: file.name,
    path: file.path,
    gated: file.gated,
  }));
}
