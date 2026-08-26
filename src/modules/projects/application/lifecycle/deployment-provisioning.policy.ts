import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
} from '../../dto/create-project.dto';
import {
  DEFAULT_BACKEND_PROVIDER_ID,
  type DeploymentProviderId,
} from '#modules/runtime/index.js';

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

export function defaultManagedRenderProjectName(
  serviceName: string,
  repoName: string,
): string {
  const base = (serviceName || repoName || 'backend')
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return `${base || 'backend'}-uat`;
}

/**
 * Default managed Render target for backend project types that did not
 * explicitly ask for hosting. Mirrors the historical createProject defaults.
 */
export function withDefaultCreateDeploymentProvisioning(input: {
  request: DeploymentProvisioningRequestDto | undefined;
  projectTypeId: string;
  serviceName: string;
  repoName: string;
  servicePath?: string | undefined;
}): DeploymentProvisioningRequestDto | undefined {
  if (!isBackendProjectType(input.projectTypeId)) {
    return input.request;
  }

  const existingTargets = input.request?.targets ?? [];
  const hasBackendRenderTarget = existingTargets.some(
    (target) =>
      ['backend', 'standalone'].includes(target.slot) &&
      target.provider === DEFAULT_BACKEND_PROVIDER_ID,
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
    targets: [
      ...existingTargets,
      {
        slot: 'backend',
        provider: DEFAULT_BACKEND_PROVIDER_ID,
        ownershipMode: 'flowci_managed',
        projectName: defaultManagedRenderProjectName(
          input.serviceName,
          input.repoName,
        ),
        branchName: 'uat',
        rootDirectory: input.servicePath?.trim() || '.',
        buildCommand: 'npm ci && npm run build',
        startCommand: 'npm run start:prod',
        renderDeployMethod: 'managed_image',
        renderServiceType: 'web_service',
        renderRuntime: 'docker',
        renderInstanceType: 'free',
        renderRegion: 'singapore',
        dockerContext: input.servicePath?.trim() || '.',
        dockerfilePath: 'Dockerfile',
        env: [],
      },
    ],
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
  const provider = request.targets.find(
    (t) =>
      t.slot === slot &&
      t.provider === DEFAULT_BACKEND_PROVIDER_ID &&
      slot === 'backend',
  )?.provider;
  return provider === DEFAULT_BACKEND_PROVIDER_ID ? provider : undefined;
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
