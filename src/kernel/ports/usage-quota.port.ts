export interface ManagedFleetCapacityFact {
  providerId: string;
  quotaCode: string;
  fleetCapConfigKey: string;
  providerLabel: string;
}

/**
 * Provider-owned quota metadata registered by the runtime composition root.
 * Billing stores and displays the values, but does not need to know which
 * deployment providers exist or how their quota keys are named.
 */
export interface ManagedQuotaDefinition extends ManagedFleetCapacityFact {
  freeLimit: number;
  proLimit: number;
}

/** Composition-only registration seam for provider-owned quota metadata. */
export interface ManagedQuotaRegistrar {
  registerManagedQuota(definition: ManagedQuotaDefinition): void;
}

export const MANAGED_QUOTA_REGISTRAR = Symbol('ManagedQuotaRegistrar');

/** Billing capability consumed by other contexts at the composition boundary. */
export interface UsageQuotaPort {
  assertWithinLimit(
    userId: string,
    limitCode: string,
    increment?: number,
  ): Promise<void>;
  assertDeploymentGlobalManagedFleetCapacity(
    fact: ManagedFleetCapacityFact,
  ): Promise<void>;
  /** @deprecated Use the explicitly scoped deployment-global method above. */
  assertManagedFleetCapacity?: (
    fact: ManagedFleetCapacityFact,
  ) => Promise<void>;
}

export const USAGE_QUOTA = Symbol('UsageQuota');
