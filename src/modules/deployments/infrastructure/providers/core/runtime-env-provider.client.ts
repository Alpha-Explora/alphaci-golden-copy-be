import type {
  DeploymentStrategy,
  EnvProvider,
  EnvVarInput,
  EnvVarScope,
  RenderEnvironmentName,
  RenderRuntime,
  RenderServiceType,
  DomainVerificationChallenge,
} from '../../../deployments.types';

export interface ProviderAccountSummary {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderDeploymentTarget {
  id: string;
  name: string;
  provider: EnvProvider;
  metadata?: Record<string, unknown>;
}

export interface ProviderProvisionResult {
  provisioned: Array<{ key: string; status: 'provisioned' }>;
  failed: Array<{ key: string; status: 'failed'; errorSummary: string }>;
}

export interface CreateProviderTargetInput {
  token: string;
  repoFullName: string;
  projectName: string;
  branchName: string;
  rootDirectory?: string;
  buildCommand?: string;
  startCommand?: string;
  deploymentStrategy?: DeploymentStrategy;
  renderServiceType?: RenderServiceType;
  renderRuntime?: RenderRuntime;
  renderInstanceType?: string;
  renderRegion?: string;
  renderEnvironmentName?: RenderEnvironmentName;
  dockerContext?: string;
  dockerfilePath?: string;
  imageUrl?: string;
  vercelOrgId?: string;
  vercelTeamId?: string;
  vercelTeamSlug?: string;
}

export interface UpsertProviderEnvInput extends EnvVarScope {
  token: string;
  targetId: string;
  vars: EnvVarInput[];
}

export interface DeleteProviderEnvInput extends EnvVarScope {
  token: string;
  targetId: string;
  key: string;
}

export interface ProviderTargetStatusInput {
  token: string;
  targetId: string;
  // BYO Vercel connections carry their own team scope on the target's
  // providerMetadata rather than the deployment's managed-account default —
  // callers must pass it through so status/history/log lookups hit the
  // right team instead of silently falling back to the managed default (or
  // no scope at all).
  vercelTeamId?: string;
  vercelTeamSlug?: string;
}

export interface ProviderTargetStatus {
  exists: boolean;
  state?: string;
  url?: string | null;
  // Provider-specific fields discovered during the live status check (e.g.
  // Render's ownerId) that are worth persisting into providerMetadata so
  // later operations (like log fetching) don't need a separate lookup.
  metadata?: Record<string, unknown>;
}

export interface DeleteProviderTargetInput {
  token: string;
  targetId: string;
}

export interface DeleteProviderTargetResult {
  deleted: boolean;
}

/**
 * Which lane a deployment belongs to. Vercel reports `target: 'production'`
 * for production and `null` for the per-PR previews it creates automatically
 * on git-connected projects; providers that don't distinguish the two report
 * null and callers fall back to the target's own environment name.
 */
export type ProviderDeployEnvironment = 'production' | 'preview';

export interface ProviderDeployEvent {
  id: string;
  status: string;
  createdAt: string;
  readyAt: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  trigger: string | null;
  // The URL this one deployment answers on, for providers that give every
  // deployment its own hostname. Render reuses a single stable service URL
  // per service, so it returns null and callers fall back to the target's
  // public URL.
  deploymentUrl: string | null;
  environment: ProviderDeployEnvironment | null;
  // Set only when the deployment was built for a pull request. A preview can
  // exist without one (a push to a non-production branch with no PR open).
  pullRequestNumber: number | null;
  // Git ref the deployment was built from.
  commitRef: string | null;
  // Provider console URL for this single deployment, as opposed to the
  // project-level console link the caller derives from the target.
  inspectorUrl: string | null;
}

export interface ProviderLogEntry {
  timestamp: string;
  message: string;
  level: string;
}

export interface ProviderLogsInput extends ProviderTargetStatusInput {
  // 'build' vs 'app'/runtime — exact meaning is provider-specific; clients
  // ignore values they don't support rather than erroring.
  type?: string;
  startTime?: string;
  endTime?: string;
  // Render's log API requires the workspace owner id, which lives on the
  // target's providerMetadata (see deployment-targets.service.ts).
  renderOwnerId?: string;
}

export interface AddProviderDomainInput extends ProviderTargetStatusInput {
  hostname: string;
  /** Pins the hostname to one branch. Omitted means the production domain. */
  gitBranch?: string | null;
}

export interface ProviderDomainInput extends ProviderTargetStatusInput {
  hostname: string;
}

export interface ProviderDomainResult {
  hostname: string;
  apexDomain: string | null;
  verified: boolean;
  /** The provider's own challenges. Empty once nothing further is required. */
  verification: DomainVerificationChallenge[];
  /**
   * Whether DNS points at the provider, when the provider reports it
   * separately from ownership. Null when unknown.
   */
  misconfigured: boolean | null;
}
export interface RuntimeEnvProviderClient {
  provider: EnvProvider;
  validateConnection(token: string): Promise<ProviderAccountSummary>;
  validateTeamAccess?(
    token: string,
    teamId: string,
  ): Promise<{ id: string; slug?: string; name?: string }>;
  listTargets(token: string): Promise<ProviderDeploymentTarget[]>;
  createTarget(
    input: CreateProviderTargetInput,
  ): Promise<ProviderDeploymentTarget>;
  upsertEnvironmentVariables(
    input: UpsertProviderEnvInput,
  ): Promise<ProviderProvisionResult>;
  deleteEnvironmentVariable(
    input: DeleteProviderEnvInput,
  ): Promise<{ key: string; status: 'removed' }>;
  getTargetStatus(
    input: ProviderTargetStatusInput,
  ): Promise<ProviderTargetStatus>;
  deleteTarget(
    input: DeleteProviderTargetInput,
  ): Promise<DeleteProviderTargetResult>;
  // Optional: not every client can list deploy/event history. Callers must
  // check for its presence before calling.
  getDeployHistory?(
    input: ProviderTargetStatusInput,
  ): Promise<ProviderDeployEvent[]>;
  // Optional: not every client can fetch runtime logs. Callers must check
  // for its presence before calling.
  getLogs?(input: ProviderLogsInput): Promise<ProviderLogEntry[]>;

  /*
   * Custom domains. Optional as a group: a provider that cannot attach a
   * hostname simply omits them, and the service reports the capability as
   * unavailable rather than failing a call. Callers must check for presence.
   */
  addDomain?(input: AddProviderDomainInput): Promise<ProviderDomainResult>;
  listDomains?(input: ProviderTargetStatusInput): Promise<ProviderDomainResult[]>;
  verifyDomain?(input: ProviderDomainInput): Promise<ProviderDomainResult>;
  removeDomain?(input: ProviderDomainInput): Promise<{ removed: true }>;
}
