import type { ProviderCiSecretsInstaller } from '../../../application/ports/provider-ci-secrets-installer.port';
import type { RuntimeEnvProviderClient } from '../../../application/ports/runtime-env-provider.client';
import type { DeploymentProvider } from '../../../core/deployment-provider.contract';
import type { DeploymentProviderPolicy } from '../../../core/deployment-provider.policy';
import type { RuntimeProviderPack } from '../../../core/provider-pack';
import type { WorkflowFragment } from '../../../core/workflow-fragment.contract';

export interface RenderProviderPackInput {
  provider: DeploymentProvider;
  policy: DeploymentProviderPolicy;
  client: RuntimeEnvProviderClient;
  workflowFragment?: WorkflowFragment | undefined;
  ciSecretsInstaller?: ProviderCiSecretsInstaller | undefined;
}

/** Assemble Render's complete Runtime contribution at its ownership boundary. */
export function createRenderProviderPack(
  input: RenderProviderPackInput,
): RuntimeProviderPack {
  return {
    id: input.provider.id,
    provider: input.provider,
    policy: input.policy,
    client: input.client,
    ...(input.workflowFragment
      ? { workflowFragment: input.workflowFragment }
      : {}),
    ...(input.ciSecretsInstaller
      ? { ciSecretsInstaller: input.ciSecretsInstaller }
      : {}),
  };
}
