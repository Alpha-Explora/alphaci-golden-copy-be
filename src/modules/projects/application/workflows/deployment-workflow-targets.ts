import type { DeploymentProvisioningRequestDto } from '../../api/dto/create-project.dto';
import type { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import type { DeploymentWorkflowTarget } from './dto/generate-workflow.dto';

export type ProvisioningSlot = 'standalone' | 'backend' | 'frontend';

/**
 * Projects does not know provider strategy names, secret names, or filtering
 * rules. It asks the provider registry port to expand each request target into
 * the workflow descriptors consumed by the generic staged builder.
 */
export function resolveDeploymentWorkflowTargets(
  request: DeploymentProvisioningRequestDto | undefined,
  slots: ProvisioningSlot[],
  fallbackRootDirectory?: string,
  workflowFragmentRegistry?: WorkflowFragmentRegistry,
): DeploymentWorkflowTarget[] {
  if (!request?.enabled || !request.targets?.length) {
    return [];
  }
  if (!workflowFragmentRegistry) {
    throw new Error(
      'A workflow fragment registry is required when deployment targets are configured',
    );
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
