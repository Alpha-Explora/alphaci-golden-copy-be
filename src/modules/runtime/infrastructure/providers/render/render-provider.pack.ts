import type { ProviderCiSecretsInstaller } from '../../../application/ports/provider-ci-secrets-installer.port';
import type { ProviderReleaser } from '../../../application/ports/provider-releaser.port';
import type { RuntimeEnvProviderClient } from '../../../application/ports/runtime-env-provider.client';
import type { DeploymentProvider } from '../../../core/deployment-provider.contract';
import type { DeploymentProviderPolicy } from '../../../domain/deployment-provider.policy';
import type { RuntimeProviderPack } from '../../../core/provider-pack';
import type { WorkflowFragment } from '../../../core/workflow-fragment.contract';

export interface RenderProviderPackInput {
  provider: DeploymentProvider;
  policy: DeploymentProviderPolicy;
  client: RuntimeEnvProviderClient;
  workflowFragment?: WorkflowFragment | undefined;
  ciSecretsInstaller?: ProviderCiSecretsInstaller | undefined;
  releaser?: ProviderReleaser | undefined;
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
    ...(input.releaser ? { releaser: input.releaser } : {}),
  };
}
