import type { WorkflowFragment } from '#kernel/ports/workflow-fragment.port';

import { ONPREM_COMPOSE_PROVIDER_ID } from './onprem-compose.provider';

/**
 * The pipeline builds and registers the image; the host pulls it. So the
 * fragment asks for a built image and contributes no deploy job, in either
 * the branch pipeline or the environments pipeline.
 */
export const onpremComposeWorkflowFragment: WorkflowFragment = {
  provider: ONPREM_COMPOSE_PROVIDER_ID,
  deploysBuiltImage: true,
  deliveredByHost: true,
  expandTargets: (target, context) => {
    const rootDirectory = target.rootDirectory ?? context.fallbackRootDirectory;
    return [
      {
        provider: target.provider,
        slot: target.slot,
        deploymentStrategy: 'provider_native',
        ...(target.branchName ? { branchName: target.branchName } : {}),
        ...(rootDirectory ? { rootDirectory } : {}),
      },
    ];
  },
  build: () => undefined,
};
