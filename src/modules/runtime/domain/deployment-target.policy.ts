/**
 * Provider/slot compatibility rules (framework- and vendor-independent).
 *
 * A deployment target pairs exactly one provider with one slot. Slot support
 * comes from the registered provider descriptor rather than a closed vendor
 * list, so a new provider can contribute its own capabilities without editing
 * this policy.
 */

export interface ProviderSlotDefinition {
  label: string;
  supportedSlots: readonly string[];
  slotViolationMessage?: (slot: string) => string;
}

export type DeploymentPolicyError = {
  code:
    | 'provider_slot_not_supported'
    | 'invalid_lane'
    | 'production_has_branch'
    | 'preview_requires_branch'
    | 'invalid_branch_name';
  message: string;
};

export class DeploymentPolicyViolation extends Error {
  readonly policyError: DeploymentPolicyError;

  constructor(policyError: DeploymentPolicyError) {
    super(policyError.message);
    this.name = 'DeploymentPolicyViolation';
    this.policyError = policyError;
  }
}

export function assertProviderSlotAllowed(
  _provider: string,
  slot: 'backend' | 'frontend' | 'standalone',
  definition?: ProviderSlotDefinition,
): void {
  if (!definition || definition.supportedSlots.includes(slot)) {
    return;
  }

  throw new DeploymentPolicyViolation({
    code: 'provider_slot_not_supported',
    message:
      definition.slotViolationMessage?.(slot) ??
      `${definition.label} deployment targets do not support the ${slot} slot.`,
  });
}

/**
 * Environment scope value object: lane + branch validated together.
 *
 * Production has no branch (the provider resolves it from its own production
 * branch setting); preview is meaningless without one. The database enforces
 * the same pairing (project_env_var_metadata_lane_branch_check).
 */
export const GIT_BRANCH_PATTERN =
  /^(?!\/)(?!.*\/\/)(?!.*\.\.)[\w\-./]{1,255}(?<!\/)$/;

export interface EnvironmentScope {
  lane: 'production' | 'preview';
  gitBranch: string | null;
}

export function validateEnvironmentScope(input: {
  lane: string;
  gitBranch?: string | null;
}): EnvironmentScope {
  if (input.lane !== 'production' && input.lane !== 'preview') {
    throw new DeploymentPolicyViolation({
      code: 'invalid_lane',
      message: 'lane must be either production or preview',
    });
  }

  const branch = input.gitBranch?.trim() ?? '';

  if (input.lane === 'production') {
    if (branch) {
      throw new DeploymentPolicyViolation({
        code: 'production_has_branch',
        message:
          "The production lane takes no branch -- the provider resolves it from the project's production branch.",
      });
    }
    return { lane: 'production', gitBranch: null };
  }

  if (!branch) {
    throw new DeploymentPolicyViolation({
      code: 'preview_requires_branch',
      message:
        'gitBranch is required for the preview lane, so the values apply to one branch.',
    });
  }
  if (!GIT_BRANCH_PATTERN.test(branch)) {
    throw new DeploymentPolicyViolation({
      code: 'invalid_branch_name',
      message: 'gitBranch is not a valid branch name',
    });
  }

  return { lane: 'preview', gitBranch: branch };
}
