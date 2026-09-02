import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import {
  DeploymentProviderPolicyRegistry,
  type DeploymentProviderPolicy,
} from './deployment-provider.policy';
import { DeploymentStrategyResolver } from './deployment-strategy.resolver';
import type { DeploymentProvider } from '../core/deployment-provider.contract';
import { DeploymentProvisioningDefaultsService } from '../application/deployment-provisioning-defaults.service';

describe('DeploymentProviderPolicyRegistry', () => {
  it('resolves provider-owned deployment behavior without a central provider switch', () => {
    const policy: DeploymentProviderPolicy = {
      providerId: 'fake-cloud',
      resolveStrategy: ({ ownershipMode }) =>
        ownershipMode === 'flowci_managed' ? 'fake_managed' : 'fake_byo',
      resolveTarget: () => ({
        storage: {},
        providerInput: {},
        providerMetadata: { policy: 'fake-cloud' },
      }),
      resolveConnectionScope: () => ({}),
      resolveOperationInput: () => ({}),
      resolveManagedToken: () => 'fake-token',
    };
    const policies = new DeploymentProviderPolicyRegistry([policy]);
    const providers = new DeploymentProviderRegistry<DeploymentProvider>();
    providers.register({
      id: 'fake-cloud',
      label: 'Fake Cloud',
      supportedSlots: ['backend'],
      capabilities: {
        envVars: false,
        logs: false,
        deployHistory: false,
        teardown: false,
        managedMode: false,
        liveStatus: false,
        connectivity: 'direct',
        enumerable: true,
        credentialCustody: 'external',
      },
      configSchema: { fields: [] },
      credentialSchema: { fields: [] },
      policy,
      isEnabled: () => ({ enabled: true }),
      validateConfig: () => undefined,
    });

    expect(policies.get('fake-cloud')).toBe(policy);
    expect(
      new DeploymentStrategyResolver(providers).resolve({
        provider: 'fake-cloud',
        ownershipMode: 'flowci_managed',
      }),
    ).toBe('fake_managed');
  });

  it('fails clearly for duplicate policies and unknown providers', () => {
    const policy: DeploymentProviderPolicy = {
      providerId: 'fake-cloud',
      resolveStrategy: () => 'fake',
      resolveTarget: () => ({
        storage: {},
        providerInput: {},
        providerMetadata: {},
      }),
      resolveConnectionScope: () => ({}),
      resolveOperationInput: () => ({}),
      resolveManagedToken: () => 'fake-token',
    };

    expect(
      () => new DeploymentProviderPolicyRegistry([policy, policy]),
    ).toThrow('Duplicate deployment provider policy: fake-cloud');
    expect(() => new DeploymentProviderPolicyRegistry().get('unknown')).toThrow(
      'Unknown deployment provider policy: unknown',
    );
  });

  it('exposes product defaults through Runtime instead of a Projects provider branch', () => {
    const defaultTarget = {
      slot: 'backend' as const,
      provider: 'render',
      ownershipMode: 'flowci_managed' as const,
      projectName: 'orders-api-uat',
      branchName: 'uat',
      rootDirectory: '.',
      buildCommand: 'npm ci && npm run build',
      startCommand: 'npm run start:prod',
      renderDeployMethod: 'managed_image' as const,
      renderServiceType: 'web_service' as const,
      renderRuntime: 'docker' as const,
      renderInstanceType: 'free',
      renderRegion: 'singapore',
      dockerContext: '.',
      dockerfilePath: 'Dockerfile',
      env: [],
    };
    const policy: DeploymentProviderPolicy = {
      providerId: 'render',
      provisioning: {
        resolveDefaultCreateTarget: () => defaultTarget,
        resolveDefaultTargetRole: () => 'backend',
        resolveCrossLinkLane: () => 'preview',
        resolvePublicUrl: () => null,
        normalizeTarget: (target) => target,
        expandTargets: ({ target }) => [target],
        defaultImageUrl: () => null,
      },
      resolveStrategy: () => 'render_image_pushed',
      resolveTarget: () => ({
        storage: {},
        providerInput: {},
        providerMetadata: {},
      }),
      resolveConnectionScope: () => ({}),
      resolveOperationInput: () => ({}),
      resolveManagedToken: () => 'fake-token',
    };

    const service = new DeploymentProvisioningDefaultsService(
      new DeploymentProviderPolicyRegistry([policy]),
    );

    expect(
      service.resolveDefaultCreateTarget({
        serviceName: 'orders-api',
        repoName: 'orders-api',
      }),
    ).toBe(defaultTarget);
  });
});
