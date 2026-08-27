import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import {
  DeploymentProviderRegistry,
} from '#modules/runtime/index.js';
import type { DeploymentProvider } from '#modules/runtime/index.js';

@Controller('capabilities')
export class CapabilitiesController {
  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: DeploymentProviderRegistry<DeploymentProvider>,
  ) {}

  @Get()
  getCapabilities() {
    const config = this.configService.getOrThrow<AppConfig>('app');
    const enabled = config.envProvisioning.enabled;
    const liveAdaptersImplemented = false;
    const registeredProviderIds = new Set(
      this.providerRegistry.list().map((provider) => provider.id),
    );
    const providers = this.providerRegistry
      .list()
      .filter(
        (provider) =>
          (provider.capabilities.envProvisioning ?? true) &&
          (!provider.isEnabled || provider.isEnabled().enabled) &&
          registeredProviderIds.has(provider.id),
      )
      .map((provider) => provider.id);
    const previewProviders = this.providerRegistry
      .list()
      .filter((provider) => provider.capabilities.previewDeployments === true)
      .map((provider) => provider.id);

    return {
      envProvisioning: {
        enabled,
        providers: enabled ? providers : [],
        environments: enabled ? ['test', 'uat', 'production'] : [],
        // Advertise the single ownership mode this deployment supports. BYO is
        // archived — deployments always centralize on the platform's own
        // Render/Vercel/SonarCloud credentials ('flowci_managed').
        modes: enabled ? [config.envProvisioning.ownershipMode] : [],
      },
      projectSyncSnapshots: {
        enabled: config.projectSyncSnapshots.enabled,
        liveGithubEnabled:
          liveAdaptersImplemented &&
          config.projectSyncSnapshots.liveGithubEnabled,
        liveProvidersEnabled:
          liveAdaptersImplemented &&
          config.projectSyncSnapshots.liveProvidersEnabled,
        mode: 'local_snapshot' as const,
      },
      workflowSettingsPreview: {
        enabled: config.workflowSettingsPreview.enabled,
      },
      workflowUpdatePr: {
        enabled: config.workflowUpdatePr.enabled,
      },
      projectTargetManagement: {
        enabled: config.projectTargetManagement.enabled,
      },
      ciRunTracking: {
        enabled: config.ciRunTracking.enabled,
        liveGithubEnabled:
          liveAdaptersImplemented && config.ciRunTracking.liveGithubEnabled,
        mode: 'local_mock' as const,
      },
      deploymentHistory: {
        enabled: config.deploymentHistory.enabled,
        liveProvidersEnabled:
          liveAdaptersImplemented &&
          config.deploymentHistory.liveProvidersEnabled,
        mode: 'local_mock' as const,
      },
      previewDeployments: {
        // Previews read the provider history, so the flag alone is not enough
        // — without deployment history there is nothing to group by branch.
        enabled:
          config.previewDeployments.enabled && config.deploymentHistory.enabled,
        // Per-branch previews come from the provider's own preview lane, which
        // only Vercel reports today.
        providers: previewProviders,
      },
      driftDetection: {
        enabled: config.driftDetection.enabled,
        liveProviderChecksEnabled:
          liveAdaptersImplemented && config.driftLiveChecks.enabled,
        mode: 'local_snapshot' as const,
      },
      driftRepair: {
        enabled: config.driftRepair.enabled,
        liveRepairEnabled:
          liveAdaptersImplemented && config.driftRepair.liveRepairEnabled,
        mode: 'local_safe' as const,
      },
      usageQuotas: {
        enabled: config.usageQuotas.enabled,
      },
      workspaces: {
        enabled: config.workspaces.enabled,
      },
      auditEvents: {
        enabled: config.auditEvents.enabled,
      },
      notifications: {
        enabled: config.notifications.enabled,
      },
      hierarchy: {
        enabled: config.hierarchy.enabled,
        githubSyncMode: config.hierarchy.githubSyncMode,
      },
    };
  }
}
