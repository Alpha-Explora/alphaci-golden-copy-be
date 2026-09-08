/**
 * Public deployment/runtime contracts.
 *
 * These are serialisable ports shared by Projects and Runtime.  Keeping them
 * below `src/kernel` prevents Projects from importing Runtime's implementation
 * barrel while preserving the same in-process tokens and public shapes.  The
 * projects context owns HTTP DTOs and validation; Runtime owns provider and
 * persistence implementations.
 */

/** Provider ids are open because providers are runtime plugins. */
export type DeploymentProvider = string;
export type DeploymentProviderId = DeploymentProvider;
export type DeploymentSlot = 'backend' | 'frontend' | 'standalone';
export type DeploymentOwnershipMode = 'byo' | 'flowci_managed';
export type DeploymentProvisioningAction = 'create' | 'register_existing';
export type DeploymentEnvironmentLane = 'production' | 'preview';
export type EnvProvider = DeploymentProvider;
export type EnvTargetSlot = DeploymentSlot;
export type EnvOwnershipMode = DeploymentOwnershipMode;
export type DeploymentStrategy = string;
export type DeploymentHistoryStatus =
  | 'queued'
  | 'building'
  | 'ready'
  | 'failed'
  | 'canceled'
  | 'unknown';
export type DeploymentHistoryMode = 'local_mock' | 'live' | 'unavailable';
export type DeploymentDriftSeverity = 'info' | 'warning' | 'error';
export type DeploymentDriftStatus = 'active' | 'resolved' | 'ignored';
export type DeploymentDriftSource = 'local_snapshot';
export type EnvVarProvisionStatus = 'provisioned' | 'failed';

/**
 * Historical provider fields remain part of this compatibility contract. They
 * are strings here so a provider plugin can add its own metadata without
 * changing the cross-context port.
 */
export interface DeploymentTargetSummary {
  id: string;
  projectId: string;
  slot: DeploymentSlot;
  ownershipMode: DeploymentOwnershipMode;
  provider: DeploymentProvider;
  providerConnectionId: string | null;
  providerProjectId: string;
  providerProjectName: string;
  repoFullName: string;
  branchName: string;
  rootDirectory: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  renderServiceType?: string | null;
  renderRuntime?: string | null;
  renderInstanceType?: string | null;
  renderRegion?: string | null;
  renderEnvironmentName?: string | null;
  dockerContext?: string | null;
  dockerfilePath?: string | null;
  imageUrl?: string | null;
  environmentMap: Record<string, unknown>;
  deploymentStrategy: DeploymentStrategy;
  providerMetadata: Record<string, unknown>;
  status: 'active' | 'missing' | 'failed';
}

export interface EnvVarMetadata {
  id: string;
  projectId: string;
  deploymentTargetId: string;
  lane: DeploymentEnvironmentLane;
  gitBranch: string | null;
  key: string;
  provider: DeploymentProvider;
  valueStored: false;
  lastProvisionedAt: string;
  lastProvisionedBy: string;
  status: EnvVarProvisionStatus;
  errorSummary: string | null;
  removedAt?: string | null;
}

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

export type ProjectDriftFinding = DeploymentDriftFinding;
export type ProjectDriftFindingInput = DeploymentDriftFindingInput;
export type ProjectDriftResponse = DeploymentDriftResponse;
export type ProjectDriftSeverity = DeploymentDriftSeverity;
export type ProjectDriftSource = DeploymentDriftSource;
export type ProjectDriftStatus = DeploymentDriftStatus;

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

/** Runtime-owned product default resolved through a provider-neutral port. */
export interface DeploymentProvisioningDefaultsPort {
  /**
   * Product default hosting target for a role.
   *
   * Takes the role because there are two defaults, not one. This resolved only
   * the backend default, so a frontend project was created with no hosting at
   * all while a backend got Render automatically — the asymmetry was silent,
   * and the frontend provider default existed but was never read.
   *
   * Returns undefined when the role's default provider declares no create
   * target, so a caller distinguishes "no default configured" from a target.
   */
  resolveDefaultCreateTarget(input: {
    role: DeploymentDefaultRole;
    serviceName: string;
    repoName: string;
    servicePath?: string | undefined;
  }): DeploymentProvisioningTarget | undefined;
}

/** Which half of a project a default hosting target is for. */
export type DeploymentDefaultRole = 'backend' | 'frontend';

export const DEPLOYMENT_PROVISIONING_DEFAULTS = Symbol(
  'DEPLOYMENT_PROVISIONING_DEFAULTS',
);

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
