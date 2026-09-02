import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import type { DeploymentProviderPolicy } from '../../../domain/deployment-provider.policy';
import { RenderDeploymentProvider } from './render-deployment.provider';

const testPolicy = {} as DeploymentProviderPolicy;

describe('RenderDeploymentProvider', () => {
  it('registers provider-owned metadata and preserves the backend slot policy', () => {
    const registry = new DeploymentProviderRegistry();
    const provider = new RenderDeploymentProvider(
      {
        label: 'Render',
        enabled: true,
        supportedSlots: ['backend'],
        previewDeployments: false,
      },
      registry,
      testPolicy,
    );

    provider.onModuleInit();

    expect(registry.get('render')).toBe(provider);
    expect(provider.supportedSlots).toEqual(['backend']);
    expect(
      provider.presentation?.publicUrl({
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api',
        providerMetadata: {},
      }),
    ).toBe('https://orders-api.onrender.com');
  });

  it('validates the provider-owned project configuration', () => {
    const provider = new RenderDeploymentProvider(
      {
        label: 'Render',
        enabled: true,
        supportedSlots: ['backend'],
      },
      new DeploymentProviderRegistry(),
      testPolicy,
    );

    expect(() => provider.validateConfig({})).toThrow(
      'providerProjectId is required',
    );
    expect(() =>
      provider.validateConfig({ providerProjectId: 'srv-1' }),
    ).not.toThrow();
  });
});
