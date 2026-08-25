export type EnvProvider = 'render' | 'vercel';

/**
 * Deployment lane an environment variable applies to.
 *
 * Mirrors what a provider actually has rather than a promotion ladder:
 * `production` is the lane the provider's production branch deploys to and
 * carries no branch of its own (Vercel resolves it from the project's
 * production-branch setting), while `preview` is always scoped to one branch.
 *
 * Replaced the old fixed 'test' | 'uat' | 'production' enum, which could not
 * express per-branch values and silently collapsed test and uat onto a single
 * Vercel record.
 */
export type EnvLane = 'production' | 'preview';

/**
 * Which values a provisioning call targets.
 *
 * The lane and the branch are not independent: production has no branch, and
 * preview is meaningless without one. The database enforces the same pairing
 * (project_env_var_metadata_lane_branch_check).
 */
export interface EnvVarScope {
  lane: EnvLane;
  /** The branch these values apply to. Null if and only if lane is production. */
  gitBranch: string | null;
}

export type EnvOwnershipMode = 'byo' | 'flowci_managed';
export type EnvTargetSlot = 'backend' | 'frontend' | 'standalone';
export type RenderDeploymentStrategy =
  | 'render_git_connected'
  | 'render_image_pushed'
  | 'render_existing_service';
export type VercelDeploymentStrategy =
  | 'vercel_git_connected'
  | 'vercel_ci_pushed';
export type DeploymentStrategy =
  | 'provider_native'
  | VercelDeploymentStrategy
  | RenderDeploymentStrategy;
export type RenderServiceType =
  | 'web_service'
  | 'private_service'
  | 'background_worker'
  | 'cron_job';
export type RenderRuntime =
  | 'node'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'elixir'
  | 'docker';
export type RenderDeployMethod =
  | 'managed_image'
  | 'byo_image'
  | 'native_git'
  | 'existing_service';
/**
 * Render's own environment naming on a deployment target.
 *
 * Deliberately NOT EnvLane: this is a Render concept stored on the target and
 * constrained separately in the database
 * (project_deployment_targets_render_environment_check). It used to alias the
 * env-var environment enum, which made two unrelated ideas move together.
 */
export type RenderEnvironmentName = 'test' | 'uat' | 'production';
export type ProviderConnectionStatus = 'active' | 'revoked' | 'failed';
export type DeploymentTargetStatus = 'active' | 'missing' | 'failed';
export type EnvVarProvisionStatus = 'provisioned' | 'failed';

export interface EnvVarInput {
  key: string;
  value: string;
}

export interface ProviderConnectionSummary {
  id: string;
  provider: EnvProvider;
  label: string;
  tokenLastFour: string;
  status: ProviderConnectionStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ProviderConnectionWithToken extends ProviderConnectionSummary {
  encryptedToken: string;
}

export interface DeploymentTargetSummary {
  id: string;
  projectId: string;
  slot: EnvTargetSlot;
  ownershipMode: EnvOwnershipMode;
  provider: EnvProvider;
  providerConnectionId: string | null;
  providerProjectId: string;
  providerProjectName: string;
  repoFullName: string;
  branchName: string;
  rootDirectory: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  renderServiceType?: RenderServiceType | null;
  renderRuntime?: RenderRuntime | null;
  renderInstanceType?: string | null;
  renderRegion?: string | null;
  renderEnvironmentName?: RenderEnvironmentName | null;
  dockerContext?: string | null;
  dockerfilePath?: string | null;
  imageUrl?: string | null;
  environmentMap: Record<string, unknown>;
  deploymentStrategy: DeploymentStrategy;
  providerMetadata: Record<string, unknown>;
  status: DeploymentTargetStatus;
}

export interface EnvVarMetadata {
  id: string;
  projectId: string;
  deploymentTargetId: string;
  lane: EnvLane;
  /** Null if and only if `lane` is production. */
  gitBranch: string | null;
  key: string;
  provider: EnvProvider;
  valueStored: false;
  lastProvisionedAt: string;
  lastProvisionedBy: string;
  status: EnvVarProvisionStatus;
  errorSummary: string | null;
  removedAt?: string | null;
}

export interface UpdateDeploymentTargetMetadataInput {
  slot?: EnvTargetSlot;
  providerProjectName?: string;
  branchName?: string;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  renderEnvironmentName?: RenderEnvironmentName | null;
}


/**
 * A DNS challenge the provider itself returned for domain verification.
 * Stored verbatim: the provider is the authority and its instructions change
 * without notice, so the UI repeats what the provider said rather than
 * hardcoding an apex IP that goes stale.
 */
export interface DomainVerificationChallenge {
  type: string;
  domain: string;
  value: string;
  reason: string;
}

export interface CustomDomainSummary {
  id: string;
  projectId: string;
  deploymentTargetId: string;
  provider: EnvProvider;
  hostname: string;
  apexDomain: string | null;
  /** Branch this hostname serves. Null for the production domain. */
  gitBranch: string | null;
  verified: boolean;
  verification: DomainVerificationChallenge[];
  /**
   * Whether DNS currently points at the provider. Null until checked once -
   * and reported separately from verified, because a domain can be verified
   * as owned while still not pointed at the deployment.
   */
  misconfigured: boolean | null;
  lastCheckedAt: string | null;
  lastErrorSafeMessage: string | null;
  createdAt: string;
  updatedAt: string;
}