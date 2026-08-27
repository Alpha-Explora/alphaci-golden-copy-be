import { ProviderClientRegistry } from './provider-client.registry';
import type { RuntimeEnvProviderClient } from '../../../application/ports/runtime-env-provider.client';

describe('ProviderClientRegistry', () => {
  it('returns the Render client for render provider targets', () => {
    const renderClient = { provider: 'render' } as RuntimeEnvProviderClient;
    const vercelClient = { provider: 'vercel' } as RuntimeEnvProviderClient;
    const registry = new ProviderClientRegistry([renderClient, vercelClient]);

    expect(registry.getClient('render')).toBe(renderClient);
  });

  it('returns the Vercel client for non-render provider targets', () => {
    const renderClient = { provider: 'render' } as RuntimeEnvProviderClient;
    const vercelClient = { provider: 'vercel' } as RuntimeEnvProviderClient;
    const registry = new ProviderClientRegistry([renderClient, vercelClient]);

    expect(registry.getClient('vercel')).toBe(vercelClient);
  });

  it('accepts a new provider plugin without changing the registry implementation', () => {
    const fakeClient = {
      provider: 'fake-cloud',
    } as RuntimeEnvProviderClient;

    const registry = new ProviderClientRegistry([fakeClient]);

    expect(registry.getClient('fake-cloud')).toBe(fakeClient);
  });

  it('fails closed for an unregistered provider instead of falling back to Vercel', () => {
    const registry = new ProviderClientRegistry([]);

    expect(() => registry.getClient('unknown-cloud')).toThrow(
      'No provider client registered for: unknown-cloud',
    );
  });
});
