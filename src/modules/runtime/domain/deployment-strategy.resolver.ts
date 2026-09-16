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

/**
 * Which deployment strategy a target uses, as decided by its provider.
 *
 * Deliberately undecorated: this is domain code and stays framework-free. That
 * means Nest cannot read the constructor on its own - with no class decorator
 * TypeScript writes no `design:paramtypes`, and a plain `DeploymentStrategyResolver`
 * provider is built with no arguments. RuntimeModule therefore builds it with a
 * factory that passes the registry explicitly.
 *
 * It used to be listed as a plain provider. The registry never arrived, every
 * target resolved to `provider_native`, and the CI secrets installers - which
 * only act on `vercel_ci_pushed` and `render_image_pushed` - skipped all 13
 * managed targets ever created. The unit tests construct this by hand, which is
 * why they passed the whole time; tests/architecture/http-boot.spec.ts is the
 * one that proves the wiring.
 *
 * `provider_native` remains the answer for a provider with no policy, such as a
 * catalog-only one. For a provider that HAS a policy it is never a real answer,
 * and DeploymentTargetsService refuses it.
 */
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
