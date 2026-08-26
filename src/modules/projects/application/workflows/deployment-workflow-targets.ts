import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
} from '../../dto/create-project.dto';
import {
  DEFAULT_BACKEND_PROVIDER_ID,
  DEFAULT_FRONTEND_PROVIDER_ID,
} from '#modules/runtime/index.js';
import type { DeploymentWorkflowTarget } from './dto/generate-workflow.dto';

export type ProvisioningSlot = DeploymentProvisioningTargetDto['slot'];

/**
 * Pure deployment-workflow mapping rules. No Nest, no I/O — these functions
 * translate a validated provisioning request into the descriptors the staged
 * workflow bundle and CI secrets consume.
 */

export function renderDeploymentBranches(): Array<'uat' | 'main'> {
  return ['uat', 'main'];
}

export function resolveRenderDeploymentStrategy(
  target: DeploymentProvisioningTargetDto,
): 'render_image_pushed' | 'render_git_connected' | 'render_existing_service' {
  if (target.renderDeployMethod === 'existing_service') {
    return 'render_existing_service';
  }
  if (
    target.ownershipMode === 'flowci_managed' ||
    target.renderDeployMethod === 'byo_image'
  ) {
    return 'render_image_pushed';
  }

  return 'render_git_connected';
}

export function resolveWorkflowRootDirectory(
  target: DeploymentProvisioningTargetDto,
  fallbackRootDirectory?: string,
): string | undefined {
  const rootDirectory = target.rootDirectory?.trim();
  if (rootDirectory) {
    return rootDirectory;
  }

  return fallbackRootDirectory?.trim() || undefined;
}

export function vercelSecretNames(
  slot: ProvisioningSlot,
): NonNullable<DeploymentWorkflowTarget['secretNames']> {
  const prefix = `VERCEL_${slot.toUpperCase()}`;
  return {
    token: `${prefix}_TOKEN`,
    orgId: `${prefix}_ORG_ID`,
    projectId: `${prefix}_PROJECT_ID`,
  };
}

export function renderSecretNames(
  slot: ProvisioningSlot,
  branchName: 'uat' | 'main' = 'uat',
): NonNullable<DeploymentWorkflowTarget['secretNames']> {
  const prefix = `RENDER_${slot.toUpperCase()}_${branchName.toUpperCase()}`;
  const branchSuffix = branchName.toUpperCase();
  return {
    apiKey: `${prefix}_API_KEY`,
    serviceId: `${prefix}_SERVICE_ID`,
    ownerId: `${prefix}_OWNER_ID`,
    registryCredentialId: `${prefix}_REGISTRY_CREDENTIAL_ID`,
    deployHookUrl: `RENDER_DEPLOY_HOOK_URL_${branchSuffix}`,
    healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branchSuffix}`,
  };
}

export function renderImageName(
  target: DeploymentProvisioningTargetDto,
  branchName: string = target.branchName ?? 'uat',
): string {
  const raw = `alphaci-${target.slot}-${branchName}-${target.projectName ?? target.slot}`;
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

export function resolveDeploymentWorkflowTargets(
  request: DeploymentProvisioningRequestDto | undefined,
  slots: ProvisioningSlot[],
  fallbackRootDirectory?: string,
): DeploymentWorkflowTarget[] {
  if (!request?.enabled || !request.targets?.length) {
    return [];
  }

  return request.targets
    .filter((target) => slots.includes(target.slot))
    .filter(
      (target) =>
        (target.provider === DEFAULT_FRONTEND_PROVIDER_ID &&
          target.slot === 'frontend') ||
        (target.provider === DEFAULT_BACKEND_PROVIDER_ID &&
          target.slot === 'backend' &&
          (target.renderInstanceType?.trim() || 'free') === 'free' &&
          (target.renderServiceType ?? 'web_service') === 'web_service' &&
          resolveRenderDeploymentStrategy(target) === 'render_image_pushed'),
    )
    .flatMap((target) => {
      const rootDirectory = resolveWorkflowRootDirectory(
        target,
        fallbackRootDirectory,
      );
      if (target.provider === DEFAULT_BACKEND_PROVIDER_ID) {
        return renderDeploymentBranches().map((branchName) => {
          const descriptor: DeploymentWorkflowTarget = {
            slot: target.slot,
            provider: DEFAULT_BACKEND_PROVIDER_ID,
            branchName,
            deploymentStrategy: 'render_image_pushed',
            secretNames: renderSecretNames(target.slot, branchName),
            dockerContext: target.dockerContext?.trim() || rootDirectory || '.',
            dockerfilePath: target.dockerfilePath?.trim() || 'Dockerfile',
            imageName: renderImageName(target, branchName),
            renderServiceType: target.renderServiceType ?? 'web_service',
            renderInstanceType: target.renderInstanceType ?? 'free',
          };
          if (rootDirectory) {
            descriptor.rootDirectory = rootDirectory;
          }

          return descriptor;
        });
      }

      const descriptor: DeploymentWorkflowTarget = {
        slot: target.slot,
        provider: DEFAULT_FRONTEND_PROVIDER_ID,
        deploymentStrategy: 'vercel_ci_pushed',
        secretNames: vercelSecretNames(target.slot),
      };
      if (rootDirectory) {
        descriptor.rootDirectory = rootDirectory;
      }

      return descriptor;
    });
}
