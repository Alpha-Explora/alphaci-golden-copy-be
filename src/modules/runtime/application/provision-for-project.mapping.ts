import type { DeploymentProvisioningTarget } from '../core/deployment-provisioning.contract';
import type { CreateDeploymentTargetDto } from '../dto/create-deployment-target.dto';

/**
 * The branch a requested target will actually track.
 *
 * Mirrors the default the deployment-target create path applies, so the scope a
 * variable is written under and the scope a user-provided key is recorded under
 * cannot disagree. They did once: the request target carried no branch while
 * the created target defaulted to 'uat', so a user's own CORS_ORIGINS no longer
 * suppressed the cross-link injection meant to defer to it.
 */
const DEFAULT_TARGET_BRANCH = 'uat';

export function requestedBranch(target: { branchName?: string }): string {
  return target.branchName?.trim() || DEFAULT_TARGET_BRANCH;
}

function resolveCreateAction(
  target: DeploymentProvisioningTarget,
): CreateDeploymentTargetDto['action'] {
  return (
    target.action ??
    (target.renderDeployMethod === 'existing_service'
      ? 'register_existing'
      : 'create')
  );
}

const OPTIONAL_CREATE_FIELDS = [
  'providerConnectionId',
  'projectName',
  'providerProjectId',
  'providerProjectName',
  'rootDirectory',
  'buildCommand',
  'startCommand',
  'renderDeployMethod',
  'renderServiceType',
  'renderRuntime',
  'renderInstanceType',
  'renderRegion',
  'renderEnvironmentName',
  'dockerContext',
  'dockerfilePath',
] as const;

type OptionalCreateField = (typeof OPTIONAL_CREATE_FIELDS)[number];

/**
 * Copies truthy optional create-target fields. Omitted keys stay omitted —
 * the create path treats a missing property differently from an explicit
 * empty string, matching the previous per-field spreads.
 */
function copyPresentOptionalFields(
  source: DeploymentProvisioningTarget,
): Partial<Pick<CreateDeploymentTargetDto, OptionalCreateField>> {
  const result: Partial<Pick<CreateDeploymentTargetDto, OptionalCreateField>> =
    {};
  for (const field of OPTIONAL_CREATE_FIELDS) {
    const value = source[field];
    if (value) {
      Object.assign(result, { [field]: value });
    }
  }
  return result;
}

export function toCreateDeploymentTargetDto(
  requestedTarget: DeploymentProvisioningTarget,
  defaultImageUrl: string | null,
): CreateDeploymentTargetDto {
  const dto: CreateDeploymentTargetDto = {
    action: resolveCreateAction(requestedTarget),
    slot: requestedTarget.slot,
    ownershipMode: requestedTarget.ownershipMode,
    provider: requestedTarget.provider,
    branchName: requestedBranch(requestedTarget),
    ...copyPresentOptionalFields(requestedTarget),
  };

  const imageUrl = requestedTarget.imageUrl || defaultImageUrl;
  if (imageUrl) {
    dto.imageUrl = imageUrl;
  }

  return dto;
}
