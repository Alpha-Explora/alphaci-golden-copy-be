import { DeploymentProviderRegistry } from './deployment-provider.registry';

describe('DeploymentProviderRegistry', () => {
  const gcpProvider = { id: 'gcp', label: 'Google Cloud Platform' };
  const renderProvider = { id: 'render', label: 'Render' };

  it('returns the provider registered for an id', () => {
    const registry = createRegistry(gcpProvider, renderProvider);

    expect(registry.get('gcp')).toBe(gcpProvider);
    expect(registry.list()).toEqual([gcpProvider, renderProvider]);
  });

  it('rejects an unknown provider id', () => {
    const registry = createRegistry(gcpProvider);

    expect(() => registry.get('unknown')).toThrow(
      'Unknown deployment provider: unknown',
    );
  });

  it('rejects duplicate provider ids', () => {
    expect(
      () =>
        createRegistry(gcpProvider, { id: 'gcp', label: 'Duplicate GCP' }),
    ).toThrow('Duplicate deployment provider id: gcp');
  });

  it('registers a provider after construction', () => {
    const registry = new DeploymentProviderRegistry();

    registry.register(gcpProvider);

    expect(registry.get('gcp')).toBe(gcpProvider);
  });
});

function createRegistry(
  ...providers: Array<{ id: string; label: string }>
): DeploymentProviderRegistry {
  const registry = new DeploymentProviderRegistry();
  providers.forEach((provider) => registry.register(provider));
  return registry;
}
