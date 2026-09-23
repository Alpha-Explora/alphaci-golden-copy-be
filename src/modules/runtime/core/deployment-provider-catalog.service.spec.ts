import { DeploymentProviderCatalogService } from './deployment-provider-catalog.service';
import { DeploymentProviderRegistry } from './deployment-provider.registry';
import type { DeploymentProvider } from './deployment-provider.contract';

function provider(
  overrides: Partial<DeploymentProvider> = {},
): DeploymentProvider {
  return {
    id: 'render',
    label: 'Render',
    supportedSlots: ['backend'],
    capabilities: {
      envVars: true,
      logs: true,
      deployHistory: true,
      teardown: true,
      managedMode: true,
      liveStatus: true,
      connectivity: 'direct',
      enumerable: true,
      credentialCustody: 'platform',
      envProvisioning: true,
      previewDeployments: false,
    },
    configSchema: { fields: [] },
    credentialSchema: { fields: [] },
    isEnabled: () => ({ enabled: true }),
    validateConfig: jest.fn(),
    ...overrides,
  };
}

describe('DeploymentProviderCatalogService', () => {
  it('exposes the label and logs capability alongside the existing fields', () => {
    const registry = new DeploymentProviderRegistry<DeploymentProvider>();
    registry.register(provider());
    const service = new DeploymentProviderCatalogService(registry);

    expect(service.list()).toEqual([
      {
        id: 'render',
        label: 'Render',
        enabled: true,
        envProvisioning: true,
        previewDeployments: false,
        logs: true,
      },
    ]);
  });

  it('reports logs false for a provider whose capabilities declare no log support', () => {
    const registry = new DeploymentProviderRegistry<DeploymentProvider>();
    registry.register(
      provider({
        id: 'gcp',
        label: 'Google Cloud Platform',
        capabilities: {
          envVars: false,
          logs: false,
          deployHistory: false,
          teardown: false,
          managedMode: true,
          liveStatus: false,
          connectivity: 'direct',
          enumerable: false,
          credentialCustody: 'platform',
          envProvisioning: false,
          previewDeployments: false,
        },
      }),
    );
    const service = new DeploymentProviderCatalogService(registry);

    expect(service.list()[0]).toMatchObject({ id: 'gcp', logs: false });
  });
});
