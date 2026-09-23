import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import type { DeploymentProviderCatalogEntry } from '#kernel/ports/deployment-provider-catalog.port';
import { DEPLOYMENT_PROVIDER_CATALOG } from '#kernel/ports/deployment-provider-catalog.port';
import { CAPABILITY_RESOLVER } from '#kernel/composition/capability-resolver.port';
import { CapabilitiesController } from './capabilities.controller';

const makeConfig = (
  enabled: boolean,
  ownershipMode: 'byo' | 'flowci_managed' = 'byo',
) =>
  ({
    getOrThrow: jest.fn().mockReturnValue({
      envProvisioning: {
        enabled,
        ownershipMode,
      },
      projectSyncSnapshots: {
        enabled,
        liveGithubEnabled: false,
        liveProvidersEnabled: false,
      },
      workflowSettingsPreview: {
        enabled,
      },
      workflowUpdatePr: {
        enabled,
      },
      projectTargetManagement: {
        enabled,
      },
      ciRunTracking: {
        enabled,
        liveGithubEnabled: false,
      },
      deploymentHistory: {
        enabled,
        liveProvidersEnabled: false,
      },
      previewDeployments: {
        enabled,
      },
      driftDetection: {
        enabled,
        liveProviderChecksEnabled: false,
      },
      driftLiveChecks: {
        enabled: false,
      },
      driftRepair: {
        enabled,
        liveRepairEnabled: false,
      },
      usageQuotas: {
        enabled,
      },
      workspaces: {
        enabled,
      },
      auditEvents: {
        enabled,
      },
      notifications: {
        enabled,
      },
      hierarchy: {
        enabled,
        githubSyncMode: 'stub',
      },
      composition: {
        edition: 'enterprise',
      },
    }),
  }) as unknown as ConfigService;

const makeProviderCatalog = () => ({
  list: (): readonly DeploymentProviderCatalogEntry[] => [
    {
      id: 'render',
      label: 'Render',
      enabled: true,
      envProvisioning: true,
      previewDeployments: false,
      logs: true,
    },
    {
      id: 'vercel',
      label: 'Vercel',
      enabled: true,
      envProvisioning: true,
      previewDeployments: true,
      logs: true,
    },
  ],
});

const providerCatalog = () => ({
  provide: DEPLOYMENT_PROVIDER_CATALOG,
  useValue: makeProviderCatalog(),
});

describe('CapabilitiesController', () => {
  it('reports env provisioning enabled capabilities', async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        { provide: ConfigService, useValue: makeConfig(true) },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: {
            deployment: () =>
              new Set([
                'identity.workspaces',
                'identity.hierarchy',
                'platform.audit-events',
                'platform.notifications',
                'billing.usage-quotas',
                'runtime.env-provisioning',
                'runtime.deployment-history',
                'runtime.preview-deployments',
                'runtime.drift-detection',
                'runtime.drift-repair',
                'projects.sync-snapshots',
                'projects.workflow-settings-preview',
                'projects.workflow-update-pr',
                'projects.target-management',
                'pipelines.ci-run-tracking',
              ]),
          },
        },
        {
          ...providerCatalog(),
        },
      ],
    }).compile();

    const controller = module.get(CapabilitiesController);

    expect(controller.getCapabilities()).toEqual({
      edition: 'enterprise',
      capabilityKeys: [
        'identity.workspaces',
        'identity.hierarchy',
        'platform.audit-events',
        'platform.notifications',
        'billing.usage-quotas',
        'runtime.env-provisioning',
        'runtime.deployment-history',
        'runtime.preview-deployments',
        'runtime.drift-detection',
        'runtime.drift-repair',
        'projects.sync-snapshots',
        'projects.workflow-settings-preview',
        'projects.workflow-update-pr',
        'projects.target-management',
        'pipelines.ci-run-tracking',
      ],
      clientComposition: {
        enabled: false,
        clientId: null,
        displayName: null,
        edition: null,
        disabledCapabilities: [],
      },
      envProvisioning: {
        enabled: true,
        providers: ['render', 'vercel'],
        environments: ['test', 'uat', 'production'],
        modes: ['byo'],
      },
      projectSyncSnapshots: {
        enabled: true,
        liveGithubEnabled: false,
        liveProvidersEnabled: false,
        mode: 'local_snapshot',
      },
      workflowSettingsPreview: {
        enabled: true,
      },
      workflowUpdatePr: {
        enabled: true,
      },
      projectTargetManagement: {
        enabled: true,
      },
      ciRunTracking: {
        enabled: true,
        liveGithubEnabled: false,
        mode: 'local_mock',
      },
      deploymentHistory: {
        enabled: true,
        liveProvidersEnabled: false,
        mode: 'local_mock',
      },
      previewDeployments: {
        enabled: true,
        providers: ['vercel'],
      },
      driftDetection: {
        enabled: true,
        liveProviderChecksEnabled: false,
        mode: 'local_snapshot',
      },
      driftRepair: {
        enabled: true,
        liveRepairEnabled: false,
        mode: 'local_safe',
      },
      usageQuotas: {
        enabled: true,
      },
      workspaces: {
        enabled: true,
      },
      auditEvents: {
        enabled: true,
      },
      notifications: {
        enabled: true,
      },
      hierarchy: {
        enabled: true,
        githubSyncMode: 'stub',
      },
    });
  });

  it('uses resolved capability membership instead of enabled config flags', async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        { provide: ConfigService, useValue: makeConfig(true) },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: { deployment: () => new Set() },
        },
        {
          ...providerCatalog(),
        },
      ],
    }).compile();

    const controller = module.get(CapabilitiesController);

    expect(controller.getCapabilities().envProvisioning.enabled).toBe(false);
    expect(controller.getCapabilities().workspaces.enabled).toBe(false);
    expect(controller.getCapabilities().previewDeployments.enabled).toBe(false);
  });

  it('advertises the flowci_managed ownership mode when centralized', async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        {
          provide: ConfigService,
          useValue: makeConfig(true, 'flowci_managed'),
        },
        {
          ...providerCatalog(),
        },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: {
            deployment: () => new Set(['runtime.env-provisioning']),
          },
        },
      ],
    }).compile();

    const controller = module.get(CapabilitiesController);

    expect(controller.getCapabilities().envProvisioning.modes).toEqual([
      'flowci_managed',
    ]);
  });

  it('reports env provisioning disabled without provider lists', async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        { provide: ConfigService, useValue: makeConfig(false) },
        {
          ...providerCatalog(),
        },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: { deployment: () => new Set() },
        },
      ],
    }).compile();

    const controller = module.get(CapabilitiesController);

    expect(controller.getCapabilities()).toEqual({
      edition: 'enterprise',
      capabilityKeys: [],
      clientComposition: {
        enabled: false,
        clientId: null,
        displayName: null,
        edition: null,
        disabledCapabilities: [],
      },
      envProvisioning: {
        enabled: false,
        providers: [],
        environments: [],
        modes: [],
      },
      projectSyncSnapshots: {
        enabled: false,
        liveGithubEnabled: false,
        liveProvidersEnabled: false,
        mode: 'local_snapshot',
      },
      workflowSettingsPreview: {
        enabled: false,
      },
      workflowUpdatePr: {
        enabled: false,
      },
      projectTargetManagement: {
        enabled: false,
      },
      ciRunTracking: {
        enabled: false,
        liveGithubEnabled: false,
        mode: 'local_mock',
      },
      deploymentHistory: {
        enabled: false,
        liveProvidersEnabled: false,
        mode: 'local_mock',
      },
      previewDeployments: {
        enabled: false,
        providers: ['vercel'],
      },
      driftDetection: {
        enabled: false,
        liveProviderChecksEnabled: false,
        mode: 'local_snapshot',
      },
      driftRepair: {
        enabled: false,
        liveRepairEnabled: false,
        mode: 'local_safe',
      },
      usageQuotas: {
        enabled: false,
      },
      workspaces: {
        enabled: false,
      },
      auditEvents: {
        enabled: false,
      },
      notifications: {
        enabled: false,
      },
      hierarchy: {
        enabled: false,
        githubSyncMode: 'stub',
      },
    });
  });

  it('does not report live adapter modes without live adapter implementations', async () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue({
        envProvisioning: { enabled: true },
        projectSyncSnapshots: {
          enabled: true,
          liveGithubEnabled: true,
          liveProvidersEnabled: true,
        },
        workflowSettingsPreview: { enabled: true },
        workflowUpdatePr: { enabled: true },
        projectTargetManagement: { enabled: true },
        ciRunTracking: { enabled: true, liveGithubEnabled: true },
        deploymentHistory: { enabled: true, liveProvidersEnabled: true },
        previewDeployments: { enabled: true },
        driftDetection: { enabled: true },
        driftLiveChecks: { enabled: true },
        driftRepair: { enabled: true, liveRepairEnabled: true },
        usageQuotas: { enabled: true },
        workspaces: { enabled: true },
        auditEvents: { enabled: true },
        notifications: { enabled: true },
        hierarchy: { enabled: true, githubSyncMode: 'stub' },
        composition: { edition: 'enterprise', profile: 'enterprise' },
      }),
    };
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        { provide: ConfigService, useValue: configService },
        {
          ...providerCatalog(),
        },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: { deployment: () => new Set() },
        },
      ],
    }).compile();

    const controller = module.get(CapabilitiesController);

    expect(controller.getCapabilities()).toMatchObject({
      projectSyncSnapshots: {
        liveGithubEnabled: false,
        liveProvidersEnabled: false,
        mode: 'local_snapshot',
      },
      ciRunTracking: {
        liveGithubEnabled: false,
        mode: 'local_mock',
      },
      deploymentHistory: {
        liveProvidersEnabled: false,
        mode: 'local_mock',
      },
      driftDetection: {
        liveProviderChecksEnabled: false,
        mode: 'local_snapshot',
      },
      driftRepair: {
        liveRepairEnabled: false,
        mode: 'local_safe',
      },
    });
  });
});
