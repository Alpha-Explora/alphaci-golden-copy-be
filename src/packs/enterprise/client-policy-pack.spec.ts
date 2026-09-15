import type { AppConfig } from '#kernel/config/app.config.js';
import { createEnterpriseClientPolicyPack } from './client-policy-pack.js';

const northwind = {
  clientId: 'northwind',
  displayName: 'Northwind Industries',
  edition: 'enterprise',
  disabledCapabilities: ['runtime.preview-deployments'],
} as const;

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

describe('EnterpriseClientPolicyPack', () => {
  it('resolves the declared Northwind preset as a deny-only policy', () => {
    const pack = createEnterpriseClientPolicyPack();
    const source = pack.createSource(
      compositionFor({ id: 'northwind', configPath: null }),
    );
    const policy = source.deployment();

    expect(policy).toEqual(northwind);
    expect(policy).not.toHaveProperty('enabledCapabilities');
    expect(policy?.disabledCapabilities).toEqual([
      'runtime.preview-deployments',
    ]);
  });

  it('preserves declared policy lookup and mounted-config precedence', () => {
    const pack = createEnterpriseClientPolicyPack({
      policies: { northwind },
      readFile: () =>
        JSON.stringify({
          clientId: 'contoso',
          edition: 'enterprise',
          disabledCapabilities: ['runtime.air-gap-packaging'],
        }),
    });

    const source = pack.createSource(
      compositionFor({
        id: null,
        configPath: '/etc/alphaci/client.json',
      }),
    );

    expect(source.deployment()).toEqual({
      clientId: 'contoso',
      displayName: 'contoso',
      edition: 'enterprise',
      disabledCapabilities: ['runtime.air-gap-packaging'],
    });
  });

  it('rejects a mounted policy whose edition does not match the deployment', () => {
    const pack = createEnterpriseClientPolicyPack({
      readFile: () =>
        JSON.stringify({
          clientId: 'contoso',
          edition: 'enterprise',
          disabledCapabilities: [],
        }),
    });

    expect(() =>
      pack.createSource(
        compositionFor(
          { id: null, configPath: '/etc/alphaci/client.json' },
          'edu',
        ),
      ),
    ).toThrow(/declares edition 'enterprise' but this deployment runs 'edu'/);
  });
});
