import type { AppConfig } from '#kernel/config/app.config.js';
import type { ClientPolicyRegistry } from '#kernel/composition/client-policy.types.js';
import { createEnterpriseClientPolicySource } from './client-policy-pack.js';
import { NullClientPolicySource } from './client-policy-source.js';

const northwind = {
  clientId: 'northwind',
  displayName: 'Northwind Industries',
  edition: 'enterprise',
  disabledCapabilities: ['runtime.preview-deployments'],
} as const;

const declared: ClientPolicyRegistry = { northwind };

type ClientSelection = Pick<
  AppConfig['composition']['client'],
  'id' | 'configPath'
>;

const compositionFor = (
  client: ClientSelection,
  edition: AppConfig['composition']['edition'] = 'enterprise',
): AppConfig['composition'] => ({
  edition,
  profile: 'enterprise',
  client: {
    ...client,
    enabled: client.id !== null || client.configPath !== null,
  },
});

describe('createEnterpriseClientPolicySource', () => {
  it('returns a null source when no client is selected', () => {
    const source = createEnterpriseClientPolicySource(
      compositionFor({ id: null, configPath: null }),
      { policies: declared },
    );

    expect(source).toBeInstanceOf(NullClientPolicySource);
    expect(source.deployment()).toBeNull();
    expect(source.for({ tenantId: 'tenant-1' })).toBeNull();
  });

  it('resolves a declared client policy', () => {
    const source = createEnterpriseClientPolicySource(
      compositionFor({ id: 'northwind', configPath: null }),
      { policies: declared },
    );

    expect(source.deployment()).toEqual(northwind);
    expect(source.for({ tenantId: 'tenant-1' })).toEqual(northwind);
  });

  it('fails closed on an unknown declared client', () => {
    expect(() =>
      createEnterpriseClientPolicySource(
        compositionFor({ id: 'ghost', configPath: null }),
        { policies: declared },
      ),
    ).toThrow(/Unknown ALPHACI_CLIENT 'ghost'.*northwind/s);
  });

  it('reads a deployment-supplied policy document', () => {
    const source = createEnterpriseClientPolicySource(
      compositionFor({ id: null, configPath: '/etc/alphaci/client.json' }),
      {
        policies: {},
        readFile: () =>
          JSON.stringify({
            clientId: 'contoso',
            edition: 'enterprise',
            disabledCapabilities: ['runtime.air-gap-packaging'],
          }),
      },
    );

    expect(source.deployment()).toEqual({
      clientId: 'contoso',
      displayName: 'contoso',
      edition: 'enterprise',
      disabledCapabilities: ['runtime.air-gap-packaging'],
    });
  });

  it('rejects a mounted policy that names a different client', () => {
    expect(() =>
      createEnterpriseClientPolicySource(
        compositionFor({
          id: 'northwind',
          configPath: '/etc/alphaci/client.json',
        }),
        {
          policies: declared,
          readFile: () =>
            JSON.stringify({
              clientId: 'contoso',
              edition: 'enterprise',
              disabledCapabilities: [],
            }),
        },
      ),
    ).toThrow(/declares client 'contoso' but ALPHACI_CLIENT is 'northwind'/);
  });

  it('reports an unreadable or malformed policy file', () => {
    expect(() =>
      createEnterpriseClientPolicySource(
        compositionFor({ id: null, configPath: '/missing.json' }),
        {
          readFile: () => {
            throw new Error('ENOENT: no such file');
          },
        },
      ),
    ).toThrow(/Cannot read ALPHACI_CLIENT_CONFIG '\/missing.json': ENOENT/);

    expect(() =>
      createEnterpriseClientPolicySource(
        compositionFor({ id: null, configPath: '/broken.json' }),
        { readFile: () => '{ not json' },
      ),
    ).toThrow(/is not valid JSON/);
  });

  it('rejects a mounted policy written for another edition', () => {
    expect(() =>
      createEnterpriseClientPolicySource(
        compositionFor(
          { id: null, configPath: '/etc/alphaci/client.json' },
          'edu',
        ),
        {
          readFile: () =>
            JSON.stringify({
              clientId: 'contoso',
              edition: 'enterprise',
              disabledCapabilities: [],
            }),
        },
      ),
    ).toThrow(/declares edition 'enterprise' but this deployment runs 'edu'/);
  });

  it('rejects a policy that removes a capability outside the edition', () => {
    expect(() =>
      createEnterpriseClientPolicySource(
        compositionFor({ id: null, configPath: '/etc/alphaci/client.json' }),
        {
          readFile: () =>
            JSON.stringify({
              clientId: 'contoso',
              edition: 'enterprise',
              disabledCapabilities: ['identity.lms-lti'],
            }),
        },
      ),
    ).toThrow(/does not contain/);
  });
});
