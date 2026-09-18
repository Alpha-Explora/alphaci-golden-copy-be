import type { AppConfig } from '#kernel/config/app.config.js';
import { createEnterpriseClientPolicyPack } from './client-policy-pack.js';

/** Mirrors the policy that ships in `clients/index.ts`. */
const stPeter = {
  clientId: 'st-peter',
  displayName: 'St. Peter',
  edition: 'enterprise',
  disabledCapabilities: [],
} as const;

/**
 * An injected policy, deliberately not the shipped one: the tests below are
 * about lookup and mounted-config precedence, so using a client the registry
 * does not declare keeps them from passing for the wrong reason.
 */
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
  /*
   * Reads the registry that actually ships, so renaming the declared client
   * without updating what selects it fails here rather than at a customer's
   * startup. The fixtures below inject their own policies and are unaffected.
   */
  it('resolves the declared St. Peter preset as a deny-only policy', () => {
    const pack = createEnterpriseClientPolicyPack();
    const source = pack.createSource(
      compositionFor({ id: 'st-peter', configPath: null }),
    );
    const policy = source.deployment();

    expect(policy).toEqual(stPeter);
    expect(policy).not.toHaveProperty('enabledCapabilities');
    // Narrowed to nothing: an empty deny list is a policy, not a gap.
    expect(policy?.disabledCapabilities).toEqual([]);
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
