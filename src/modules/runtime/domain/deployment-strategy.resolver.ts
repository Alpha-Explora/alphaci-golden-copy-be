import type {
  DeploymentStrategy,
  EnvOwnershipMode,
  EnvProvider,
  RenderDeployMethod,
} from '../core/deployments.types';
import type { DeploymentProvider } from '../core/deployment-provider.contract';
import type { DeploymentProviderRegistry } from '../core/deployment-provider.registry';

export interface ResolveDeploymentStrategyInput {
  provider: EnvProvider;
  ownershipMode: EnvOwnershipMode;
  action?: 'create' | 'register_existing';
  renderDeployMethod?: RenderDeployMethod | undefined;
}

export class DeploymentStrategyResolver {
  constructor(
    private readonly providerRegistry?: DeploymentProviderRegistry<DeploymentProvider>,
  ) {}

  resolve(input: ResolveDeploymentStrategyInput): DeploymentStrategy {
    return (
      this.providerRegistry?.find(input.provider)?.policy?.resolveStrategy({
        ownershipMode: input.ownershipMode,
        ...(input.action ? { action: input.action } : {}),
        ...(input.renderDeployMethod
          ? { renderDeployMethod: input.renderDeployMethod }
          : {}),
      }) ?? 'provider_native'
    );
  }
}
