import { DeploymentProviderRegistry } from '../../src/modules/runtime/core/deployment-provider.registry';
import { DeploymentProviderCatalogService } from '../../src/modules/runtime/core/deployment-provider-catalog.service';
import {
  DeploymentProviderPolicyRegistry,
  type DeploymentProviderPolicy,
} from '../../src/modules/runtime/core/deployment-provider.policy';
import { ProviderCiSecretsInstallerRegistry } from '../../src/modules/runtime/infrastructure/providers/core/provider-ci-secrets.registry';
import { ProviderClientRegistry } from '../../src/modules/runtime/infrastructure/providers/core/provider-client.registry';
import { RuntimeProviderPackRegistry } from '../../src/modules/runtime/core/provider-pack';
import { WorkflowFragmentRegistry } from '../../src/modules/runtime/core/workflow-fragment.contract';
import type { DeploymentProvider } from '../../src/modules/runtime/core/deployment-provider.contract';
import type { RuntimeEnvProviderClient } from '../../src/modules/runtime/application/ports/runtime-env-provider.client';
import type { ProviderCiSecretsInstaller } from '../../src/modules/runtime/application/ports/provider-ci-secrets-installer.port';
import type { WorkflowFragment } from '../../src/modules/runtime/core/workflow-fragment.contract';
import type { WorkflowTemplate } from '../../src/modules/projects/application/catalog/catalog.service';
import { buildStagedWorkflowBundle } from '../../src/modules/projects/application/workflows/staged-workflow.builder';

/**
 * Contract-level acceptance test for the provider axis. A fourth provider is
 * represented only by its own metadata/client/workflow/CI contributions; the
 * registries and application-facing contracts do not need a vendor switch.
 */
describe('provider plugin composition', () => {
  it('registers metadata, runtime I/O, workflow, and CI contributions by id', async () => {
    const policy: DeploymentProviderPolicy = {
      providerId: 'fake-cloud',
      resolveStrategy: () => 'fake_native',
      resolveTarget: () => ({
        storage: {},
        providerInput: {},
        providerMetadata: { policy: 'fake-cloud' },
      }),
      resolveConnectionScope: () => ({}),
      resolveOperationInput: () => ({}),
      resolveManagedToken: () => 'fake-token',
    };
    const provider: DeploymentProvider = {
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
        connectivity: 'direct',
        enumerable: true,
        credentialCustody: 'external',
        envProvisioning: true,
      },
      configSchema: { fields: [] },
      credentialSchema: { fields: [] },
      policy,
      isEnabled: () => ({ enabled: true }),
      validateConfig: () => undefined,
    };
    const client = {
      provider: 'fake-cloud',
    } as RuntimeEnvProviderClient;
    const fragment: WorkflowFragment = {
      provider: 'fake-cloud',
      expandTargets: (target, context) => [
        {
          provider: target.provider,
          slot: target.slot,
          deploymentStrategy: 'fake_native',
          ...(context.fallbackRootDirectory
            ? { rootDirectory: context.fallbackRootDirectory }
            : {}),
        },
      ],
      build: () => ({
        jobs: { 'deploy-fake-cloud': { runs_on: 'ubuntu-latest' } },
        jobIds: ['deploy-fake-cloud'],
        promotionNeeds: [],
      }),
    };
    const installer: ProviderCiSecretsInstaller = {
      provider: 'fake-cloud',
      supports: () => true,
      installForTarget: async () => ({ githubSecrets: {} }),
    };

    const providerPacks = new RuntimeProviderPackRegistry([
      {
        id: 'fake-cloud',
        provider,
        client,
        policy,
        workflowFragment: fragment,
        ciSecretsInstaller: installer,
      },
    ]);
    const metadata = new DeploymentProviderRegistry<DeploymentProvider>();
    const clients = new ProviderClientRegistry(
      providerPacks
        .list()
        .flatMap((pack) => (pack.client ? [pack.client] : [])),
    );
    const policies = new DeploymentProviderPolicyRegistry(
      providerPacks
        .list()
        .flatMap((pack) => (pack.policy ? [pack.policy] : [])),
    );
    const workflows = new WorkflowFragmentRegistry(
      providerPacks
        .list()
        .flatMap((pack) =>
          pack.workflowFragment ? [pack.workflowFragment] : [],
        ),
    );
    const ciInstallers = new ProviderCiSecretsInstallerRegistry(
      providerPacks
        .list()
        .flatMap((pack) =>
          pack.ciSecretsInstaller ? [pack.ciSecretsInstaller] : [],
        ),
    );

    metadata.register(provider);

    const catalog = new DeploymentProviderCatalogService(metadata);

    expect(providerPacks.get('fake-cloud').provider).toBe(provider);
    expect(metadata.get('fake-cloud')).toBe(provider);
    expect(catalog.list()).toEqual([
      {
        id: 'fake-cloud',
        enabled: true,
        envProvisioning: true,
        previewDeployments: false,
      },
    ]);
    expect(policies.get('fake-cloud')).toBe(policy);
    expect(clients.getClient('fake-cloud')).toBe(client);
    expect(workflows.get('fake-cloud')).toBe(fragment);
    expect(
      workflows.expandTargets(
        { provider: 'fake-cloud', slot: 'backend' },
        { fallbackRootDirectory: 'services/api' },
      ),
    ).toEqual([
      {
        provider: 'fake-cloud',
        slot: 'backend',
        deploymentStrategy: 'fake_native',
        rootDirectory: 'services/api',
      },
    ]);
    expect(ciInstallers.get('fake-cloud')).toBe(installer);

    const template: WorkflowTemplate = {
      id: 'be-nestjs',
      name: 'Backend API',
      description: 'Fake provider acceptance template',
      iconName: 'server',
      categories: ['backend'],
      filePatterns: ['**/*.ts'],
      stack: 'nestjs',
      propertiesPath: '/properties.json',
      workflowPath: '/template.yml',
    };
    const bundle = buildStagedWorkflowBundle(
      template,
      {
        templateId: template.id,
        serviceName: 'orders-api',
        deploymentTargets: [
          {
            provider: 'fake-cloud',
            slot: 'backend',
            deploymentStrategy: 'fake_native',
          },
        ],
      },
      workflows,
    );
    const packageWorkflow = bundle.workflowFiles.find(
      (file) => file.stage === 'package',
    );

    expect(packageWorkflow?.yaml).toContain('deploy-fake-cloud');
  });
});
