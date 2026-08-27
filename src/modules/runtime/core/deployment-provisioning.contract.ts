import type {
  DeploymentTargetSummary,
  EnvVarMetadata,
} from './deployments.types';

/**
 * Public deployment-provisioning contract.
 *
 * This file deliberately contains plain TypeScript shapes only.  The
 * projects context owns the HTTP DTOs and their validation decorators; the
 * deployments context owns the application contract used after validation.
 * Keeping the two separate prevents the deployment implementation from
 * importing presentation types from Projects.
 */

/** Provider ids are open because providers are runtime plugins. */
export type DeploymentProvider = string;
export type DeploymentSlot = 'backend' | 'frontend' | 'standalone';
export type DeploymentOwnershipMode = 'byo' | 'flowci_managed';
export type DeploymentProvisioningAction = 'create' | 'register_existing';
export type DeploymentEnvironmentLane = 'production' | 'preview';

export interface DeploymentProvisioningEnvVar {
  key: string;
  value: string;
}

export interface DeploymentProvisioningEnvSet {
  lane: DeploymentEnvironmentLane;
  gitBranch?: string;
  vars: DeploymentProvisioningEnvVar[];
}

export interface DeploymentProvisioningTarget {
  action?: DeploymentProvisioningAction;
  slot: DeploymentSlot;
  provider: DeploymentProvider;
  ownershipMode: DeploymentOwnershipMode;
  providerConnectionId?: string;
  projectName?: string;
  providerProjectId?: string;
  providerProjectName?: string;
  branchName?: string;
  rootDirectory?: string;
  buildCommand?: string;
  startCommand?: string;
  renderDeployMethod?:
    | 'managed_image'
    | 'byo_image'
    | 'native_git'
    | 'existing_service';
  renderServiceType?:
    | 'web_service'
    | 'private_service'
    | 'background_worker'
    | 'cron_job';
  renderRuntime?:
    | 'node'
    | 'python'
    | 'ruby'
    | 'go'
    | 'rust'
    | 'elixir'
    | 'docker';
  renderInstanceType?: string;
  renderRegion?: string;
  renderEnvironmentName?: 'test' | 'uat' | 'production';
  dockerContext?: string;
  dockerfilePath?: string;
  imageUrl?: string;
  env?: DeploymentProvisioningEnvSet[];
}

export interface DeploymentProvisioningVariableGroup {
  name?: string;
  provider: DeploymentProvider;
  appliesTo?: 'all' | 'selected';
  targetBranches?: string[];
  env: DeploymentProvisioningEnvSet[];
}

export interface DeploymentProvisioningRequest {
  enabled: boolean;
  variableGroups?: DeploymentProvisioningVariableGroup[];
  sharedEnv?: DeploymentProvisioningEnvSet[];
  targets: DeploymentProvisioningTarget[];
}

export interface DeploymentProvisioningInput {
  projectId: string;
  userId: string;
  repoFullName: string;
  githubAccessToken?: string;
  request: DeploymentProvisioningRequest | undefined;
}

/**
 * Project data the Deployments context is allowed to consume. The reference
 * is resolved by Projects at the composition boundary; Deployments never
 * receives a Project aggregate or repository row.
 */
export interface DeploymentProjectReference {
  projectId: string;
  userId: string;
  repoFullName: string;
  /** Optional project metadata needed by deployment-owned drift analysis. */
  repoUrl?: string | null;
  workflowPath?: string | null;
  projectOptions?: Record<string, unknown> | null;
}

export interface DeploymentProjectReferenceLookup {
  findProjectReference(
    projectId: string,
    userId: string,
  ): Promise<DeploymentProjectReference | null>;
}

export const DEPLOYMENT_PROJECT_REFERENCE_LOOKUP = Symbol(
  'DEPLOYMENT_PROJECT_REFERENCE_LOOKUP',
);

export type DeploymentHistoryStatus =
  | 'queued'
  | 'building'
  | 'ready'
  | 'failed'
  | 'canceled'
  | 'unknown';

export type DeploymentHistoryMode = 'local_mock' | 'live' | 'unavailable';

export interface DeploymentHistoryItem {
  id: string;
  targetId: string;
  targetName: string;
  provider: DeploymentProvider;
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  status: DeploymentHistoryStatus;
  createdAt: string;
  readyAt: string | null;
  deploymentUrl: string | null;
  pullRequestNumber: number | null;
  inspectorUrl: string | null;
  dashboardUrl: string;
  consoleUrl: string;
}

export interface DeploymentHistoryResponse {
  enabled: boolean;
  mode: DeploymentHistoryMode;
  liveProvidersEnabled: boolean;
  deployments: DeploymentHistoryItem[];
  providerError: string | null;
}

export interface DeploymentHistoryQuery {
  listDeployments(
    project: DeploymentProjectReference,
  ): Promise<DeploymentHistoryResponse>;
}

export const DEPLOYMENT_HISTORY_QUERY = Symbol('DEPLOYMENT_HISTORY_QUERY');

export type DeploymentDriftSeverity = 'info' | 'warning' | 'error';
export type DeploymentDriftStatus = 'active' | 'resolved' | 'ignored';
export type DeploymentDriftSource = 'local_snapshot';

export interface DeploymentDriftFinding {
  id: string;
  projectId: string;
  targetId: string | null;
  source: DeploymentDriftSource;
  severity: DeploymentDriftSeverity;
  code: string;
  message: string;
  details: Record<string, unknown>;
  status: DeploymentDriftStatus;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface DeploymentDriftFindingInput {
  projectId: string;
  targetId?: string | null;
  source: DeploymentDriftSource;
  severity: DeploymentDriftSeverity;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface DeploymentDriftResponse {
  enabled: boolean;
  mode: 'local_snapshot';
  findings: DeploymentDriftFinding[];
}

export interface DeploymentDriftQuery {
  listFindings(
    project: DeploymentProjectReference,
  ): Promise<DeploymentDriftResponse>;
  runDetection(
    project: DeploymentProjectReference,
  ): Promise<DeploymentDriftResponse>;
}

export const DEPLOYMENT_DRIFT_QUERY = Symbol('DEPLOYMENT_DRIFT_QUERY');

/** Narrow persistence port used by drift detection and the project repair flow. */
export interface DeploymentDriftFindingsStore {
  findActiveByProject(projectId: string): Promise<DeploymentDriftFinding[]>;
  findByIdForProject(
    projectId: string,
    findingId: string,
  ): Promise<DeploymentDriftFinding | null>;
  markStatus(findingId: string, status: 'resolved' | 'ignored'): Promise<void>;
  replaceActiveFindings(
    projectId: string,
    findings: DeploymentDriftFindingInput[],
  ): Promise<DeploymentDriftFinding[]>;
}

export const DEPLOYMENT_DRIFT_FINDINGS_STORE = Symbol(
  'DEPLOYMENT_DRIFT_FINDINGS_STORE',
);

export interface DeploymentTargetsQuery {
  listDeploymentTargets(projectId: string): Promise<DeploymentTargetSummary[]>;
}

export const DEPLOYMENT_TARGETS_QUERY = Symbol('DEPLOYMENT_TARGETS_QUERY');

export interface DeploymentEnvMetadataQuery {
  listEnvMetadata(projectId: string): Promise<EnvVarMetadata[]>;
}

export const DEPLOYMENT_ENV_METADATA_QUERY = Symbol(
  'DEPLOYMENT_ENV_METADATA_QUERY',
);

export interface DeploymentTargetDeletion {
  deleteDeploymentTargetForUser(
    projectId: string,
    targetId: string,
    userId: string,
  ): Promise<boolean>;
}

export const DEPLOYMENT_TARGET_DELETION = Symbol('DEPLOYMENT_TARGET_DELETION');

export type DeploymentProvisioningResult = {
  status: 'skipped' | 'completed' | 'partial' | 'failed';
  targets: Array<{
    slot: DeploymentSlot;
    provider: DeploymentProvider;
    ownershipMode: DeploymentOwnershipMode;
    deploymentStrategy: string | null;
    status: 'created' | 'registered' | 'failed';
    deploymentTargetId: string | null;
    providerProjectId: string | null;
    providerProjectName: string | null;
    providerMetadata: Record<string, unknown>;
    renderServiceType?: string | null;
    renderRuntime?: string | null;
    renderInstanceType?: string | null;
    renderRegion?: string | null;
    renderEnvironmentName?: 'test' | 'uat' | 'production' | null;
    dockerContext?: string | null;
    dockerfilePath?: string | null;
    imageUrl?: string | null;
    branchName?: string | null;
    errorSummary: string | null;
    env: Array<{
      lane: DeploymentEnvironmentLane;
      gitBranch: string | null;
      provisioned: Array<{ key: string; status: 'provisioned' }>;
      failed: Array<{
        key: string;
        status: 'failed';
        errorSummary: string;
      }>;
    }>;
  }>;
};

export interface DeploymentProvisioningFacade {
  provisionForProject(
    input: DeploymentProvisioningInput,
  ): Promise<DeploymentProvisioningResult>;
  crossLinkServiceUrls(input: {
    userId: string;
    request: DeploymentProvisioningRequest | undefined;
    groups: Array<{
      projectId: string;
      result: DeploymentProvisioningResult;
    }>;
  }): Promise<void>;
}

export const DEPLOYMENT_PROVISIONING_FACADE = Symbol(
  'DEPLOYMENT_PROVISIONING_FACADE',
);
