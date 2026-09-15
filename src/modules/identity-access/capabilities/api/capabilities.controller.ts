import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import {
  CLIENT_POLICY_SOURCE,
  type ClientPolicySource,
} from '#kernel/composition/client-policy.port';
import {
  CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port';
import type { CapabilityKey } from '#kernel/composition/capability-types';
import {
  DEPLOYMENT_PROVIDER_CATALOG,
  type DeploymentProviderCatalogPort,
} from '#kernel/ports/deployment-provider-catalog.port';
import { resolveLiveAdapterStatus } from './live-adapter-status';

@Controller('capabilities')
export class CapabilitiesController {
  constructor(
    private readonly configService: ConfigService,
    @Inject(CAPABILITY_RESOLVER)
    private readonly capabilityResolver: CapabilityResolverPort,
    @Inject(DEPLOYMENT_PROVIDER_CATALOG)
    private readonly providerCatalog: DeploymentProviderCatalogPort,
    @Optional()
    @Inject(CLIENT_POLICY_SOURCE)
    private readonly clientPolicySource: ClientPolicySource | null,
  ) {}

  @Get()
  getCapabilities() {
    const config = this.configService.getOrThrow<AppConfig>('app');
    const capabilityKeys = this.capabilityResolver.deployment();
    const has = (key: CapabilityKey): boolean => capabilityKeys.has(key);
    const clientPolicy = this.clientPolicySource?.deployment() ?? null;
    const clientCompositionEnabled =
      has('runtime.client-composition') && clientPolicy !== null;
    const enabled = has('runtime.env-provisioning');
    const liveAdaptersImplemented = resolveLiveAdapterStatus().implemented;
    const registeredProviders = this.providerCatalog.list();
    const registeredProviderIds = new Set(
      registeredProviders.map((provider) => provider.id),
    );
    const providers = registeredProviders
      .filter(
        (provider) =>
          provider.envProvisioning &&
          provider.enabled &&
          registeredProviderIds.has(provider.id),
      )
      .map((provider) => provider.id);
    const previewProviders = registeredProviders
      .filter((provider) => provider.previewDeployments)
      .map((provider) => provider.id);

    return {
      edition: config.composition.edition,
      capabilityKeys: [...capabilityKeys],
      clientComposition: {
        enabled: clientCompositionEnabled,
        clientId: clientCompositionEnabled
          ? (clientPolicy?.clientId ?? null)
          : null,
        displayName: clientCompositionEnabled
          ? (clientPolicy?.displayName ?? null)
          : null,
        edition: clientCompositionEnabled
          ? (clientPolicy?.edition ?? null)
          : null,
        disabledCapabilities: clientCompositionEnabled
          ? [...(clientPolicy?.disabledCapabilities ?? [])]
          : [],
      },
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
        enabled: has('projects.sync-snapshots'),
        liveGithubEnabled:
          liveAdaptersImplemented &&
          has('projects.sync-snapshots') &&
          config.projectSyncSnapshots.liveGithubEnabled,
        liveProvidersEnabled:
          liveAdaptersImplemented &&
          has('projects.sync-snapshots') &&
          config.projectSyncSnapshots.liveProvidersEnabled,
        mode: 'local_snapshot' as const,
      },
      workflowSettingsPreview: {
        enabled: has('projects.workflow-settings-preview'),
      },
      workflowUpdatePr: {
        enabled: has('projects.workflow-update-pr'),
      },
      projectTargetManagement: {
        enabled: has('projects.target-management'),
      },
      ciRunTracking: {
        enabled: has('pipelines.ci-run-tracking'),
        liveGithubEnabled:
          has('pipelines.ci-run-tracking') &&
          liveAdaptersImplemented &&
          config.ciRunTracking.liveGithubEnabled,
        mode: 'local_mock' as const,
      },
      deploymentHistory: {
        enabled: has('runtime.deployment-history'),
        liveProvidersEnabled:
          has('runtime.deployment-history') &&
          liveAdaptersImplemented &&
          config.deploymentHistory.liveProvidersEnabled,
        mode: 'local_mock' as const,
      },
      previewDeployments: {
        // Previews read the provider history, so the flag alone is not enough
        // — without deployment history there is nothing to group by branch.
        enabled: has('runtime.preview-deployments'),
        // Per-branch previews come from the provider's own preview lane, which
        // only Vercel reports today.
        providers: previewProviders,
      },
      driftDetection: {
        enabled: has('runtime.drift-detection'),
        liveProviderChecksEnabled:
          has('runtime.drift-detection') &&
          liveAdaptersImplemented &&
          config.driftLiveChecks.enabled,
        mode: 'local_snapshot' as const,
      },
      driftRepair: {
        enabled: has('runtime.drift-repair'),
        liveRepairEnabled:
          has('runtime.drift-repair') &&
          liveAdaptersImplemented &&
          config.driftRepair.liveRepairEnabled,
        mode: 'local_safe' as const,
      },
      usageQuotas: {
        enabled: has('billing.usage-quotas'),
      },
      workspaces: {
        enabled: has('identity.workspaces'),
      },
      auditEvents: {
        enabled: has('platform.audit-events'),
      },
      notifications: {
        enabled: has('platform.notifications'),
      },
      hierarchy: {
        enabled: has('identity.hierarchy'),
        githubSyncMode: config.hierarchy.githubSyncMode,
      },
    };
  }
}
