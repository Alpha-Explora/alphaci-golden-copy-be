import type { DeploymentProvisioningRequestDto } from '../../dto/create-project.dto';
import { createDefaultWorkflowFragmentRegistry } from '#modules/runtime/index.js';
import type { WorkflowFragmentRegistry } from '#modules/runtime/index.js';
import type { DeploymentWorkflowTarget } from './dto/generate-workflow.dto';

export type ProvisioningSlot = 'standalone' | 'backend' | 'frontend';

/**
 * Projects does not know provider strategy names, secret names, or filtering
 * rules. It asks the Runtime provider registry to expand each request target
 * into the workflow descriptors consumed by the generic staged builder.
 */
export function resolveDeploymentWorkflowTargets(
  request: DeploymentProvisioningRequestDto | undefined,
  slots: ProvisioningSlot[],
  fallbackRootDirectory?: string,
  workflowFragmentRegistry: WorkflowFragmentRegistry = createDefaultWorkflowFragmentRegistry(),
): DeploymentWorkflowTarget[] {
  if (!request?.enabled || !request.targets?.length) {
    return [];
  }

  const context =
    fallbackRootDirectory === undefined ? {} : { fallbackRootDirectory };

  return request.targets
    .filter((target) => slots.includes(target.slot))
    .flatMap(
      (target) =>
        workflowFragmentRegistry.expandTargets(
          { ...target, providerData: { ...target } },
          context,
        ) as DeploymentWorkflowTarget[],
    );
}
