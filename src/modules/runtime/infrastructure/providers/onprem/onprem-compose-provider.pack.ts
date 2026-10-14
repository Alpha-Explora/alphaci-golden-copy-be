import type { DeploymentProvider } from '../../../core/deployment-provider.contract';
import type { RuntimeProviderPack } from '../../../core/provider-pack';
import { onpremComposeWorkflowFragment } from './onprem-compose-workflow.fragment';

/**
 * The on-prem contribution: a descriptor and a workflow fragment. There is no
 * provider client, CI secret installer, or releaser, because AlphaCI never
 * calls the host; the host calls AlphaCI.
 */
export function createOnpremComposeProviderPack(input: {
  provider: DeploymentProvider;
}): RuntimeProviderPack {
  return {
    id: input.provider.id,
    provider: input.provider,
    workflowFragment: onpremComposeWorkflowFragment,
  };
}
