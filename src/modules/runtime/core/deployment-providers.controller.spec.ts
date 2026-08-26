import type { DeploymentProvider } from './deployment-provider.contract';
import { DeploymentProviderRegistry } from './deployment-provider.registry';
import { DeploymentProvidersController } from './deployment-providers.controller';

describe('DeploymentProvidersController', () => {
  it('lists provider metadata and enabled state without credentials', () => {
    const provider: DeploymentProvider = {
      id: 'gcp',
      label: 'Google Cloud Platform',
      supportedSlots: ['backend', 'frontend'],
      capabilities: {
        envVars: true,
        logs: true,
        deployHistory: true,
        teardown: true,
        managedMode: true,
        liveStatus: true,
        connectivity: 'direct',
        enumerable: false,
        credentialCustody: 'platform',
      },
      configSchema: {
        fields: [{ key: 'projectId', label: 'Project ID', required: true }],
      },
      credentialSchema: { fields: [] },
      isEnabled: () => ({
        enabled: false,
        reason: 'GCP deployments are disabled',
      }),
      validateConfig: jest.fn(),
    };
    const registry = new DeploymentProviderRegistry<DeploymentProvider>();
    registry.register(provider);
    const controller = new DeploymentProvidersController(registry);

    expect(controller.list()).toEqual({
      providers: [
        {
          id: 'gcp',
          label: 'Google Cloud Platform',
          enabled: false,
          reason: 'GCP deployments are disabled',
          supportedSlots: ['backend', 'frontend'],
          capabilities: provider.capabilities,
          configSchema: provider.configSchema,
          credentialSchema: provider.credentialSchema,
        },
      ],
    });
  });
});
