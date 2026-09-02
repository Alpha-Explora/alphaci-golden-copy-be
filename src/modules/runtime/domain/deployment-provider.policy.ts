import type {
  DeploymentProvisioningTarget,
  DeploymentEnvironmentLane,
} from '../core/deployment-provisioning.contract';
import type {
  DeploymentStrategy,
  EnvOwnershipMode,
  RenderDeployMethod,
  RenderEnvironmentName,
  RenderRuntime,
  RenderServiceType,
} from '../core/deployments.types';
import type { ManagedQuotaDefinition } from '#kernel/ports/usage-quota.port';

export interface DeploymentProviderPublicUrlInput {
  providerProjectId: string | null;
  providerProjectName: string | null;
  providerMetadata: Record<string, unknown>;
  branchName: string | null;
  lane: DeploymentEnvironmentLane;
}

export interface DeploymentProviderLogEntry {
  timestamp: string;
  message: string;
  level: string;
}

export interface DeploymentProviderMockLogsInput {
  providerProjectName: string | null;
  now: Date;
}

/**
 * Provider-owned provisioning conventions used by cross-linking and the
 * managed-target expansion path. Keeping these callbacks beside the provider
 * policy prevents the application service from growing another Render/Vercel
 * switch every time a provider gets a new deployment convention.
 */
export interface DeploymentProviderProvisioningPolicy {
  /**
   * Optional product default for a provider-backed create flow.  The runtime
   * selects which provider is the product default; the provider owns the
   * target shape and naming details.
   */
  resolveDefaultCreateTarget?(input: {
    serviceName: string;
    repoName: string;
    servicePath?: string | undefined;
  }): DeploymentProvisioningTarget;
  resolveDefaultTargetRole(): 'backend' | 'frontend';
  resolveCrossLinkLane(input: {
    branchName: string | null;
    renderEnvironmentName?: string | null;
  }): DeploymentEnvironmentLane | null;
  resolvePublicUrl(input: DeploymentProviderPublicUrlInput): string | null;
  normalizeTarget(
    target: DeploymentProvisioningTarget,
  ): DeploymentProvisioningTarget;
  expandTargets(input: {
    target: DeploymentProvisioningTarget;
    allTargets: readonly DeploymentProvisioningTarget[];
  }): DeploymentProvisioningTarget[];
  defaultImageUrl(input: {
    repoFullName: string;
    target: DeploymentProvisioningTarget;
  }): string | null;
}

/**
 * Provider-owned deployment strategy input. The compatibility fields are kept
 * here because the public API and database still expose the historical Render
 * vocabulary; the application does not interpret them.
 */
export interface DeploymentProviderStrategyInput {
  ownershipMode: EnvOwnershipMode;
  action?: 'create' | 'register_existing';
  renderDeployMethod?: RenderDeployMethod | undefined;
}

export interface DeploymentProviderTargetPolicyInput {
  ownershipMode: EnvOwnershipMode;
  action: 'create' | 'register_existing';
  branchName: string;
  rootDirectory?: string | undefined;
  imageUrl?: string | undefined;
  renderDeployMethod?: RenderDeployMethod | undefined;
  renderServiceType?: RenderServiceType | undefined;
  renderRuntime?: RenderRuntime | undefined;
  renderInstanceType?: string | undefined;
  renderRegion?: string | undefined;
  renderEnvironmentName?: RenderEnvironmentName | undefined;
  dockerContext?: string | undefined;
  dockerfilePath?: string | undefined;
  connectionMetadata: Record<string, unknown>;
  managedConfig: Record<string, unknown>;
}

/**
 * Storage fields are deliberately optional. A provider may have no legacy
 * columns at all, while Render continues to populate these columns for
 * compatibility with the existing API and migrations.
 */
export interface DeploymentProviderStorageFields {
  renderServiceType?: RenderServiceType | null;
  renderRuntime?: RenderRuntime | null;
  renderInstanceType?: string | null;
  renderRegion?: string | null;
  renderEnvironmentName?: RenderEnvironmentName | null;
  dockerContext?: string | null;
  dockerfilePath?: string | null;
}

export interface DeploymentProviderTargetPolicyResult {
  storage: DeploymentProviderStorageFields;
  /** Fields forwarded unchanged to the provider client. */
  providerInput: Record<string, unknown>;
  /** Metadata written when an existing provider resource is registered. */
  providerMetadata: Record<string, unknown>;
}

export interface DeploymentProviderConnectionScopeInput {
  ownershipMode: EnvOwnershipMode;
  connectionMetadata: Record<string, unknown>;
  managedConfig: Record<string, unknown>;
}

export type DeploymentProviderManagedQuota = Omit<
  ManagedQuotaDefinition,
  'providerId'
>;

/**
 * The provider axis. A new provider contributes one implementation in its own
 * folder and registers it; application orchestration only consumes this
 * provider-neutral contract.
 */
export interface DeploymentProviderPolicy {
  readonly providerId: string;
  readonly managedQuota?: DeploymentProviderManagedQuota;
  readonly provisioning?: DeploymentProviderProvisioningPolicy;
  resolveStrategy(input: DeploymentProviderStrategyInput): DeploymentStrategy;
  resolveTarget(
    input: DeploymentProviderTargetPolicyInput,
  ): DeploymentProviderTargetPolicyResult;
  resolveConnectionScope(
    input: DeploymentProviderConnectionScopeInput,
  ): Record<string, unknown>;
  /** Additional provider fields needed by status/history/log operations. */
  resolveOperationInput(input: {
    ownershipMode: EnvOwnershipMode;
    providerMetadata: Record<string, unknown>;
    managedConfig: Record<string, unknown>;
  }): Record<string, unknown>;
  /** Provider-owned fallback log samples used when live logs are unavailable. */
  resolveMockLogs?(
    input: DeploymentProviderMockLogsInput,
  ): readonly DeploymentProviderLogEntry[];
  resolveManagedToken(input: {
    managedConfig: Record<string, unknown>;
  }): string;
}

/** Runtime composition registry for provider-owned policy implementations. */
export class DeploymentProviderPolicyRegistry {
  private readonly policiesByProvider = new Map<
    string,
    DeploymentProviderPolicy
  >();

  constructor(policies: readonly DeploymentProviderPolicy[] = []) {
    policies.forEach((policy) => this.register(policy));
  }

  register(policy: DeploymentProviderPolicy): void {
    if (this.policiesByProvider.has(policy.providerId)) {
      throw new Error(
        `Duplicate deployment provider policy: ${policy.providerId}`,
      );
    }
    this.policiesByProvider.set(policy.providerId, policy);
  }

  get(providerId: string): DeploymentProviderPolicy {
    const policy = this.policiesByProvider.get(providerId);
    if (!policy) {
      throw new Error(`Unknown deployment provider policy: ${providerId}`);
    }
    return policy;
  }

  find(providerId: string): DeploymentProviderPolicy | undefined {
    return this.policiesByProvider.get(providerId);
  }

  list(): DeploymentProviderPolicy[] {
    return [...this.policiesByProvider.values()];
  }
}
