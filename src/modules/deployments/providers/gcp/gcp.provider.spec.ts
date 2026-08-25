import { DeploymentProviderRegistry } from '../../core/deployment-provider.registry';
import { GcpDeploymentProvider } from './gcp.provider';

describe('GcpDeploymentProvider', () => {
  it('registers itself and stays unavailable while GCP deployments are disabled', () => {
    const registry = new DeploymentProviderRegistry();
    const provider = new GcpDeploymentProvider(
      {
        enabled: false,
        projectId: '',
        region: 'asia-southeast1',
        artifactRegistryRepository: '',
      },
      registry,
    );

    provider.onModuleInit();

    expect(registry.get('gcp')).toBe(provider);
    expect(provider.isEnabled()).toEqual({
      enabled: false,
      reason: 'GCP deployments are disabled',
    });
  });

  it('rejects an incomplete GCP deployment target configuration', () => {
    const provider = new GcpDeploymentProvider(
      {
        enabled: true,
        projectId: 'alpha-runtime',
        region: 'asia-southeast1',
        artifactRegistryRepository: 'alphaci-images',
      },
      new DeploymentProviderRegistry(),
    );

    expect(() => provider.validateConfig({ projectId: 'alpha-runtime' })).toThrow(
      'GCP deployment configuration requires region and service',
    );
  });
});
