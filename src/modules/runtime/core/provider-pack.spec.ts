import { RuntimeProviderPackRegistry } from './provider-pack';
import type { RuntimeProviderPack } from './provider-pack';
import { createGcpProviderPack } from '../infrastructure/providers/gcp/gcp-provider.pack';
import { createRenderProviderPack } from '../infrastructure/providers/render/render-provider.pack';
import { createVercelProviderPack } from '../infrastructure/providers/vercel/vercel-provider.pack';

function pack(
  overrides: Partial<RuntimeProviderPack> = {},
): RuntimeProviderPack {
  const provider = {
    id: 'fake-cloud',
    label: 'Fake Cloud',
    supportedSlots: ['backend'],
    capabilities: {
      envVars: true,
      logs: false,
      deployHistory: false,
      teardown: true,
      managedMode: false,
      liveStatus: true,
      connectivity: 'direct' as const,
      enumerable: true,
      credentialCustody: 'external' as const,
      envProvisioning: true,
    },
    configSchema: { fields: [] },
    credentialSchema: { fields: [] },
    isEnabled: () => ({ enabled: true }),
    validateConfig: () => undefined,
  };
  const client = { provider: 'fake-cloud' };

  return {
    id: 'fake-cloud',
    provider,
    client,
    ...overrides,
  } as RuntimeProviderPack;
}

describe('RuntimeProviderPackRegistry', () => {
  it('derives provider pack identity from provider-owned contribution factories', () => {
    const renderProvider = { id: 'render' } as RuntimeProviderPack['provider'];
    const vercelProvider = {
      id: 'vercel',
    } as RuntimeProviderPack['provider'];
    const gcpProvider = { id: 'gcp' } as RuntimeProviderPack['provider'];
    const renderPolicy = {
      providerId: 'render',
    } as RuntimeProviderPack['policy'];
    const vercelPolicy = {
      providerId: 'vercel',
    } as RuntimeProviderPack['policy'];
    const renderClient = {
      provider: 'render',
    } as RuntimeProviderPack['client'];
    const vercelClient = {
      provider: 'vercel',
    } as RuntimeProviderPack['client'];
    const renderFragment = {
      provider: 'render',
    } as RuntimeProviderPack['workflowFragment'];
    const vercelFragment = {
      provider: 'vercel',
    } as RuntimeProviderPack['workflowFragment'];
    const renderInstaller = {
      provider: 'render',
    } as RuntimeProviderPack['ciSecretsInstaller'];
    const vercelInstaller = {
      provider: 'vercel',
    } as RuntimeProviderPack['ciSecretsInstaller'];

    expect(
      createRenderProviderPack({
        provider: renderProvider,
        policy: renderPolicy!,
        client: renderClient!,
        workflowFragment: renderFragment!,
        ciSecretsInstaller: renderInstaller!,
      }),
    ).toMatchObject({ id: 'render', provider: renderProvider });
    expect(
      createVercelProviderPack({
        provider: vercelProvider,
        policy: vercelPolicy!,
        client: vercelClient!,
        workflowFragment: vercelFragment!,
        ciSecretsInstaller: vercelInstaller!,
      }),
    ).toMatchObject({ id: 'vercel', provider: vercelProvider });
    expect(createGcpProviderPack({ provider: gcpProvider })).toEqual({
      id: 'gcp',
      provider: gcpProvider,
    });
  });

  it('returns a complete provider contribution pack by id', () => {
    const contribution = pack();
    const registry = new RuntimeProviderPackRegistry([contribution]);

    expect(registry.get('fake-cloud')).toBe(contribution);
    expect(registry.list()).toEqual([contribution]);
  });

  it('rejects duplicate pack ids', () => {
    expect(() => new RuntimeProviderPackRegistry([pack(), pack()])).toThrow(
      'Duplicate runtime provider pack: fake-cloud',
    );
  });

  it('rejects a contribution whose provider metadata does not match its id', () => {
    expect(
      () =>
        new RuntimeProviderPackRegistry([
          pack({
            id: 'other-cloud',
          }),
        ]),
    ).toThrow("Provider pack 'other-cloud' contains provider 'fake-cloud'");
  });

  it('requires a runtime client when provider metadata enables environment provisioning', () => {
    const incomplete = { ...pack() } as RuntimeProviderPack;
    delete (incomplete as { client?: RuntimeProviderPack['client'] }).client;

    expect(() => new RuntimeProviderPackRegistry([incomplete])).toThrow(
      "Provider pack 'fake-cloud' enables environment provisioning but has no runtime client",
    );
  });

  it('allows catalog-only providers to omit runtime contributions', () => {
    const base = pack();
    const contribution = pack({
      id: 'catalog-only',
      provider: {
        ...base.provider,
        id: 'catalog-only',
        capabilities: {
          ...base.provider.capabilities,
          envProvisioning: false,
        },
      },
    });
    delete (contribution as { client?: RuntimeProviderPack['client'] }).client;
    delete (contribution as { policy?: RuntimeProviderPack['policy'] }).policy;

    expect(() => new RuntimeProviderPackRegistry([contribution])).not.toThrow();
  });
});
