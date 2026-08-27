import { DeploymentStrategyResolver } from '../domain/deployment-strategy.resolver';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import type { DeploymentProvider } from '../core/deployment-provider.contract';
import type { DeploymentProviderPolicy } from '../core/deployment-provider.policy';
import { RenderCostPolicyService } from '../infrastructure/providers/render/render-cost-policy.service';
import { RenderDeploymentPolicy } from '../infrastructure/providers/render/render-deployment.policy';
import { VercelDeploymentPolicy } from '../infrastructure/providers/vercel/vercel-deployment.policy';

describe('DeploymentStrategyResolver', () => {
  const configService = {
    getOrThrow: jest.fn(() => ({
      envProvisioning: {
        flowciManaged: {
          renderDefaultInstanceType: 'free',
          renderDefaultRegion: 'singapore',
          renderAllowedInstanceTypes: ['free'],
          renderAllowPaidManaged: false,
        },
      },
    })),
  };
  const renderPolicy = new RenderDeploymentPolicy(
    new RenderCostPolicyService(configService as never),
  );
  const vercelPolicy = new VercelDeploymentPolicy();
  const registry = new DeploymentProviderRegistry<DeploymentProvider>();
  registry.register(provider('render', renderPolicy));
  registry.register(provider('vercel', vercelPolicy));
  const resolver = new DeploymentStrategyResolver(registry);

  it('uses CI-pushed deployments for ALPHACI-managed Vercel targets', () => {
    expect(
      resolver.resolve({
        provider: 'vercel',
        ownershipMode: 'flowci_managed',
      }),
    ).toBe('vercel_ci_pushed');
  });

  it('uses CI-pushed deployments for BYO Vercel targets', () => {
    expect(
      resolver.resolve({
        provider: 'vercel',
        ownershipMode: 'byo',
      }),
    ).toBe('vercel_ci_pushed');
  });

  it('uses image-pushed deployments for ALPHACI-managed Render targets', () => {
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'flowci_managed',
      }),
    ).toBe('render_image_pushed');
  });

  it('uses native Git unless BYO Render asks for image deployment', () => {
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'byo',
      }),
    ).toBe('render_git_connected');
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'byo',
        renderDeployMethod: 'byo_image',
      }),
    ).toBe('render_image_pushed');
  });

  it('uses existing-service strategy when registering Render services', () => {
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'byo',
        action: 'register_existing',
      }),
    ).toBe('render_existing_service');
  });
});

function provider(
  id: string,
  policy: DeploymentProviderPolicy,
): DeploymentProvider {
  return {
    id,
    label: id,
    supportedSlots: [],
    capabilities: {
      envVars: false,
      logs: false,
      deployHistory: false,
      teardown: false,
      managedMode: false,
      liveStatus: false,
      connectivity: 'direct',
      enumerable: true,
      credentialCustody: 'external',
    },
    configSchema: { fields: [] },
    credentialSchema: { fields: [] },
    policy,
    isEnabled: () => ({ enabled: true }),
    validateConfig: () => undefined,
  };
}
