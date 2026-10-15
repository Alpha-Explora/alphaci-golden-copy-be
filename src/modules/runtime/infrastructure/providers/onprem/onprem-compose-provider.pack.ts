import type { DeploymentProvider } from '../../../core/deployment-provider.contract';
import type { RuntimeProviderPack } from '../../../core/provider-pack';
import { onpremComposeWorkflowFragment } from './onprem-compose-workflow.fragment';
import type { DeploymentHistorySource } from '../../../application/ports/deployment-history-source.port';

/**
 * The on-prem contribution: a descriptor and a workflow fragment. There is no
 * provider client, CI secret installer, or releaser, because AlphaCI never
 * calls the host; the host calls AlphaCI.
 */
export function createOnpremComposeProviderPack(input: {
  provider: DeploymentProvider;
  historySource?: DeploymentHistorySource;
}): RuntimeProviderPack {
  return {
    id: input.provider.id,
    provider: input.provider,
    workflowFragment: onpremComposeWorkflowFragment,
    ...(input.historySource ? { historySource: input.historySource } : {}),
  };
}
