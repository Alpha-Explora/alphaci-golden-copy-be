import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { LegacyDeploymentProvider } from './legacy-deployment.provider';

describe('LegacyDeploymentProvider', () => {
  it('registers an enabled Render compatibility descriptor without credentials', () => {
    const registry = new DeploymentProviderRegistry();
    const provider = new LegacyDeploymentProvider(
      {
        id: 'render',
        label: 'Render',
        enabled: true,
        supportedSlots: ['backend', 'standalone'],
      },
      registry,
    );

    provider.onModuleInit();

    expect(registry.get('render')).toMatchObject({
      id: 'render',
      label: 'Render',
      supportedSlots: ['backend', 'standalone'],
      credentialSchema: { fields: [] },
      capabilities: expect.objectContaining({
        enumerable: true,
        teardown: true,
      }),
    });
    expect(provider.isEnabled()).toEqual({ enabled: true });
  });

  it('reports a disabled legacy provider without accepting missing target config', () => {
    const provider = new LegacyDeploymentProvider(
      {
        id: 'vercel',
        label: 'Vercel',
        enabled: false,
        supportedSlots: ['frontend'],
      },
      new DeploymentProviderRegistry(),
    );

    expect(provider.isEnabled()).toEqual({
      enabled: false,
      reason: 'Vercel provisioning is disabled',
    });
    expect(() => provider.validateConfig({})).toThrow(
      'providerProjectId is required',
    );
  });
});
