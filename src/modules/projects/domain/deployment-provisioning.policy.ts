import { normalizeRepoShape } from '../scaffold.builder';
import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
} from '../api/dto/create-project.dto';
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
 * Applies the Runtime-owned product default for a project type that did not
 * explicitly ask for hosting. Projects only preserves the request shape;
 * provider identity and provider-specific target fields come from Runtime.
 *
 * This used to return early for anything that was not a backend, so a React
 * project created without touching the wizard's hosting step got no deployment
 * target and its pipeline deployed nowhere — while an equivalent backend got
 * Render automatically. Both roles now resolve their default.
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
  const role: 'backend' | 'frontend' = isBackendProjectType(input.projectTypeId)
    ? 'backend'
    : 'frontend';

  const defaultTarget =
    input.deploymentProvisioningDefaults?.resolveDefaultCreateTarget({
      role,
      serviceName: input.serviceName,
      repoName: input.repoName,
      servicePath: input.servicePath,
    });
  if (!defaultTarget) {
    return input.request;
  }

  // A target the caller already configured for this role wins. 'standalone' is
  // included because a single-repo project may describe its one service with
  // that slot rather than naming a half.
  const slotsForRole =
    role === 'backend' ? ['backend', 'standalone'] : ['frontend', 'standalone'];
  const existingTargets = input.request?.targets ?? [];
  const hasDefaultProviderTarget = existingTargets.some(
    (target) =>
      slotsForRole.includes(target.slot) &&
      target.provider === defaultTarget.provider,
  );
  if (hasDefaultProviderTarget) {
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
 * The frontend half's default, for shapes that have two halves.
 *
 * withDefaultCreateDeploymentProvisioning resolves one role from one project
 * type, and the multi-repo and microservices provisioners hand it the
 * backend's. So a two-repository project created without the wizard's hosting
 * step got Render for its backend and nothing for its frontend: no Vercel
 * project, no Vercel variables, and a frontend pipeline that deployed nowhere.
 *
 * The role is known here, so it is passed rather than guessed from the project
 * type. A frontend target the caller configured wins, whatever its provider.
 */
export function withDefaultFrontendDeploymentProvisioning(input: {
  request: DeploymentProvisioningRequestDto | undefined;
  serviceName: string;
  repoName: string;
  servicePath?: string | undefined;
  deploymentProvisioningDefaults?:
    | DeploymentProvisioningDefaultsPort
    | undefined;
}): DeploymentProvisioningRequestDto | undefined {
  const existingTargets = input.request?.targets ?? [];
  if (existingTargets.some((target) => target.slot === 'frontend')) {
    return input.request;
  }

  const defaultTarget =
    input.deploymentProvisioningDefaults?.resolveDefaultCreateTarget({
      role: 'frontend',
      serviceName: input.serviceName,
      repoName: input.repoName,
      servicePath: input.servicePath,
    });
  // Anything but a frontend target would be provisioned as a second backend
  // service, not as this half's hosting.
  if (defaultTarget?.slot !== 'frontend') {
    return input.request;
  }

  return {
    ...input.request,
    enabled: true,
    targets: [...existingTargets, defaultTarget],
  };
}

/**
 * BYO hosting is archived: every deployment target is forced onto the
 * platform's centralized Render/Vercel credentials regardless of what the
 * client sent, and any BYO provider-connection reference is dropped.
 */
/**
 * Slot-named root directories only exist in the microservices shape.
 *
 * The create wizard defaults a backend target's rootDirectory to "backend" and
 * a frontend target's to "frontend" for every shape. Only the microservices
 * scaffold has those directories: a single-app repo carries its service at the
 * root, and each multi-repo repository carries a flat standalone scaffold. So a
 * single-app project was provisioned pointing Render at a folder that does not
 * exist, and the deploy failed with "Root directory backend does not exist"
 * after a green build.
 *
 * Only the two literal slot names are corrected, and only for shapes that lack
 * them. A path someone chose deliberately — a BYO repository with its service
 * in a subdirectory — is left alone, because overriding that would trade this
 * bug for a worse one.
 */
export function withRepoShapeRootDirectory(
  request: DeploymentProvisioningRequestDto | undefined,
  repoShape: string | null | undefined,
): DeploymentProvisioningRequestDto | undefined {
  if (!request) {
    return undefined;
  }
  if (normalizeRepoShape(repoShape) === 'microservices') {
    return request;
  }

  return {
    ...request,
    targets: request.targets.map((target) => {
      const looksLikeSlotDefault =
        target.rootDirectory === 'backend' ||
        target.rootDirectory === 'frontend';

      return looksLikeSlotDefault ? { ...target, rootDirectory: '.' } : target;
    }),
  };
}

export function forceManagedProvisioning(
  request: DeploymentProvisioningRequestDto | undefined,
  deliveredByHost: (provider: string) => boolean = () => false,
): DeploymentProvisioningRequestDto | undefined {
  if (!request) {
    return undefined;
  }

  return {
    ...request,
    targets: request.targets.map((target) => {
      // An on-prem host is the customer's own machine, never a managed account.
      if (deliveredByHost(target.provider)) return target;
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
