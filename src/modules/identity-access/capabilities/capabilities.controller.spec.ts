import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { DeploymentProviderRegistry } from '#modules/runtime/index.js';
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
    }),
  }) as unknown as ConfigService;

const makeProviderRegistry = () => {
  const registry = new DeploymentProviderRegistry();
  registry.register({ id: 'render' });
  registry.register({ id: 'vercel' });
  return registry;
};

describe('CapabilitiesController', () => {
  it('reports env provisioning enabled capabilities', async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        { provide: ConfigService, useValue: makeConfig(true) },
        {
          provide: DeploymentProviderRegistry,
          useValue: makeProviderRegistry(),
        },
      ],
    }).compile();

    const controller = module.get(CapabilitiesController);

    expect(controller.getCapabilities()).toEqual({
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

  it('advertises the flowci_managed ownership mode when centralized', async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        {
          provide: ConfigService,
          useValue: makeConfig(true, 'flowci_managed'),
        },
        {
          provide: DeploymentProviderRegistry,
          useValue: makeProviderRegistry(),
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
          provide: DeploymentProviderRegistry,
          useValue: makeProviderRegistry(),
        },
      ],
    }).compile();

    const controller = module.get(CapabilitiesController);

    expect(controller.getCapabilities()).toEqual({
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
      }),
    };
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        { provide: ConfigService, useValue: configService },
        {
          provide: DeploymentProviderRegistry,
          useValue: makeProviderRegistry(),
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
