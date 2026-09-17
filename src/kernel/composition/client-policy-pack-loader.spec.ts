import type { ClientPolicySource } from './client-policy.port.js';
import type { ClientPolicyPack } from './client-policy-pack.port.js';
import { loadClientPolicyPack } from './client-policy-pack-loader.js';

const enterprisePack: ClientPolicyPack = {
  edition: 'enterprise',
  createSource: jest.fn(
    () =>
      ({
        deployment: () => null,
        for: () => null,
      }) as ClientPolicySource,
  ),
};

describe('loadClientPolicyPack', () => {
  it('does not ask for an Enterprise module in the hosted profile', async () => {
    const loadModule = jest.fn();

    await expect(
      loadClientPolicyPack('hosted', { loadModule }),
    ).resolves.toBeNull();

    expect(loadModule).not.toHaveBeenCalled();
  });

  it('resolves the public default pack contract by profile', async () => {
    const loadModule = jest.fn(async (specifier: string) => {
      expect(specifier).toContain('packs/enterprise');
      return { default: enterprisePack };
    });

    await expect(
      loadClientPolicyPack('enterprise', { loadModule }),
    ).resolves.toBe(enterprisePack);
  });

  it('rejects a module that does not expose a usable pack', async () => {
    await expect(
      loadClientPolicyPack('enterprise', {
        loadModule: async () => ({ default: {} }),
      }),
    ).rejects.toThrow(/client policy pack is invalid/);
  });
});
