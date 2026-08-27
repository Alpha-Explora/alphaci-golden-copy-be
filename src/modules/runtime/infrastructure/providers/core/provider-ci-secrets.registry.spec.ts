import { ProviderCiSecretsInstallerRegistry } from './provider-ci-secrets.registry';

describe('ProviderCiSecretsInstallerRegistry', () => {
  const installer = {
    provider: 'fake-cloud',
    supports: jest.fn(() => true),
    installForTarget: jest.fn(),
  };

  it('looks up provider-owned installers without a provider switch', () => {
    const registry = new ProviderCiSecretsInstallerRegistry([installer]);

    expect(registry.get('fake-cloud')).toBe(installer);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('rejects duplicate installers', () => {
    expect(
      () => new ProviderCiSecretsInstallerRegistry([installer, installer]),
    ).toThrow('Duplicate provider CI secret installer for: fake-cloud');
  });
});
