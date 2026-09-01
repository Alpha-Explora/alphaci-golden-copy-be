import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
} from '../../dto/create-project.dto';
import type {
  DeploymentProviderId,
  DeploymentProvisioningDefaultsPort,
} from '#kernel/ports/deployment-runtime.port';

export type ProvisioningSlot = DeploymentProvisioningTargetDto['slot'];

/**
 * Pure request-shaping rules for deployment provisioning. No Nest, no I/O —
 * every function here is deterministic given its inputs.
 */

export function filterDeploymentProvisioningRequest(
  request: DeploymentProvisioningRequestDto | undefined,
  slots: ProvisioningSlot[],
): DeploymentProvisioningRequestDto | undefined {
  if (!request) {
    return undefined;
  }

  return {
    enabled: request.enabled,
    ...(request.variableGroups
      ? { variableGroups: request.variableGroups }
      : {}),
    ...(request.sharedEnv ? { sharedEnv: request.sharedEnv } : {}),
    targets: request.targets.filter((target) => slots.includes(target.slot)),
  };
}

export function combineDeploymentProvisioningResults<
  TTarget extends { status: string },
>(
  results: Array<{ status: string; targets: TTarget[] }>,
): {
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  targets: TTarget[];
} {
  const targets = results.flatMap((result) => result.targets);
  if (targets.length === 0) {
    return { status: 'skipped', targets: [] };
  }

  const failedCount = targets.filter(
    (target) => target.status === 'failed',
  ).length;

  return {
    status:
      failedCount === 0
        ? 'completed'
        : failedCount === targets.length
          ? 'failed'
          : 'partial',
    targets,
  };
}

export function skippedDeploymentProvisioning(): {
  status: 'skipped';
  targets: never[];
} {
  return { status: 'skipped', targets: [] };
}

export function isBackendProjectType(projectTypeId: string): boolean {
  return !/(react|next|frontend|web|ui)/i.test(projectTypeId);
}

/**
 * Applies the Runtime-owned product default for backend project types that did
 * not explicitly ask for hosting. Projects only preserves the request shape;
 * provider identity and provider-specific target fields come from Runtime.
 */
export function withDefaultCreateDeploymentProvisioning(input: {
  request: DeploymentProvisioningRequestDto | undefined;
  projectTypeId: string;
  serviceName: string;
  repoName: string;
  servicePath?: string | undefined;
  deploymentProvisioningDefaults?:
    | DeploymentProvisioningDefaultsPort
    | undefined;
}): DeploymentProvisioningRequestDto | undefined {
  if (!isBackendProjectType(input.projectTypeId)) {
    return input.request;
  }

  const defaultTarget =
    input.deploymentProvisioningDefaults?.resolveDefaultCreateTarget({
      serviceName: input.serviceName,
      repoName: input.repoName,
      servicePath: input.servicePath,
    });
  if (!defaultTarget) {
    return input.request;
  }

  const existingTargets = input.request?.targets ?? [];
  const hasBackendRenderTarget = existingTargets.some(
    (target) =>
      ['backend', 'standalone'].includes(target.slot) &&
      target.provider === defaultTarget.provider,
  );
  if (hasBackendRenderTarget) {
    return {
      ...input.request,
      enabled: true,
      targets: existingTargets,
    };
  }

  return {
    enabled: true,
    ...(input.request?.variableGroups
      ? { variableGroups: input.request.variableGroups }
      : {}),
    ...(input.request?.sharedEnv ? { sharedEnv: input.request.sharedEnv } : {}),
    targets: [...existingTargets, defaultTarget],
  };
}

/**
 * BYO hosting is archived: every deployment target is forced onto the
 * platform's centralized Render/Vercel credentials regardless of what the
 * client sent, and any BYO provider-connection reference is dropped.
 */
export function forceManagedProvisioning(
  request: DeploymentProvisioningRequestDto | undefined,
): DeploymentProvisioningRequestDto | undefined {
  if (!request) {
    return undefined;
  }

  return {
    ...request,
    targets: request.targets.map((target) => {
      const managedTarget = {
        ...target,
        ownershipMode: 'flowci_managed' as const,
      };
      delete managedTarget.providerConnectionId;
      return managedTarget;
    }),
  };
}

export function extractDeploymentProvider(
  request: DeploymentProvisioningRequestDto | undefined,
  slot: ProvisioningSlot,
): DeploymentProviderId | undefined {
  if (!request?.enabled || !request.targets?.length) return undefined;
  // Provider identity is request data here. The historical Render default is
  // applied only by withDefaultCreateDeploymentProvisioning(); once a caller
  // supplies a target, the workflow metadata must preserve whichever provider
  // owns that slot instead of silently dropping every non-Render provider.
  return request.targets.find((target) => target.slot === slot)?.provider;
}

export function resolveSingleRepoDeploymentSlots(
  request: DeploymentProvisioningRequestDto | undefined,
): ProvisioningSlot[] {
  if (!request?.enabled || !request.targets?.length) {
    return ['standalone'];
  }

  const slots = request.targets
    .map((target) => target.slot)
    .filter((slot): slot is ProvisioningSlot =>
      ['standalone', 'frontend', 'backend'].includes(slot),
    );

  return slots.length > 0 ? Array.from(new Set(slots)) : ['standalone'];
}
