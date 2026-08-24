import { ProviderClientRegistry } from './provider-client.registry';
import type { RenderEnvClient } from '../render/render-env.client';
import type { RuntimeEnvProviderClient } from './runtime-env-provider.client';
import type { VercelEnvClient } from '../vercel/vercel-env.client';

describe('ProviderClientRegistry', () => {
  it('returns the Render client for render provider targets', () => {
    const renderClient = {} as RuntimeEnvProviderClient;
    const vercelClient = {} as RuntimeEnvProviderClient;
    const registry = new ProviderClientRegistry(
      renderClient as RenderEnvClient,
      vercelClient as VercelEnvClient,
    );

    expect(registry.getClient('render')).toBe(renderClient);
  });

  it('returns the Vercel client for non-render provider targets', () => {
    const renderClient = {} as RuntimeEnvProviderClient;
    const vercelClient = {} as RuntimeEnvProviderClient;
    const registry = new ProviderClientRegistry(
      renderClient as RenderEnvClient,
      vercelClient as VercelEnvClient,
    );

    expect(registry.getClient('vercel')).toBe(vercelClient);
  });
});
