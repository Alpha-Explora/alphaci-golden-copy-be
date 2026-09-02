import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { DeploymentTargetsRepository } from '../infrastructure/repositories/deployment-targets.repository';
import type { DeploymentTargetSummary } from '../core/deployments.types';
import { EnvTokenEncryptionService } from '../application/encryption.service';
import {
  PROVIDER_CLIENT_REGISTRY,
  type ProviderClientRegistryPort,
} from './ports/provider-client-registry.port';
import { ProviderConnectionsRepository } from '../infrastructure/repositories/provider-connections.repository';
import {
  type DeploymentHistoryQuery,
  type DeploymentHistoryResponse,
  type DeploymentProjectReference,
} from '../core/deployment-provisioning.contract';
import { LocalDeploymentHistoryProvider } from './local-deployment-history.provider';
import type { ProjectDeploymentHistoryItem } from './project-deployments.types';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import type { DeploymentProvider } from '../core/deployment-provider.contract';

/** One target's contribution to the live fetch. */
interface TargetFetchOutcome {
  items: ProjectDeploymentHistoryItem[];
  /** True when a provider request was actually issued. */
  attempted: boolean;
  /** The provider whose request failed, if it did. */
  failedProvider: string | null;
}

@Injectable()
export class ProjectDeploymentsService implements DeploymentHistoryQuery {
  private readonly logger = new Logger(ProjectDeploymentsService.name);

  constructor(
    private readonly deploymentTargetsRepository: DeploymentTargetsRepository,
    private readonly provider: LocalDeploymentHistoryProvider = new LocalDeploymentHistoryProvider(),
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    @Inject(PROVIDER_CLIENT_REGISTRY)
    private readonly clientRegistry?: ProviderClientRegistryPort,
    @Optional()
    private readonly providerConnectionsRepository?: ProviderConnectionsRepository,
    @Optional()
    private readonly encryptionService?: EnvTokenEncryptionService,
    @Optional()
    private readonly providerRegistry?: DeploymentProviderRegistry<DeploymentProvider>,
  ) {}

  async listDeployments(
    project: DeploymentProjectReference,
  ): Promise<DeploymentHistoryResponse> {
    const { projectId, userId } = project;
    if (!this.enabled()) {
      return {
        enabled: false,
        mode: 'local_mock',
        liveProvidersEnabled: this.liveProvidersEnabled(),
        deployments: [],
        providerError: null,
      };
    }

    const targets =
      await this.deploymentTargetsRepository.listDeploymentTargets(projectId);
    const liveProvidersEnabled = this.liveProvidersEnabled();
    const live = await this.fetchLiveDeployments(targets, userId);
    const providerError = this.providerErrorMessage(live.failedProviders);

    // Nothing was asked: no registry, no targets, or no target with a
    // resolvable token. That is the only case where "not connected" is true.
    if (live.attempted === 0) {
      return {
        enabled: true,
        mode: 'local_mock',
        liveProvidersEnabled,
        deployments: await this.provider.listDeployments(targets),
        providerError: null,
      };
    }

    // Asked and got nothing but failures. Falling back to the fixture feed
    // here is what used to report a provider outage as "simulated data".
    if (live.items.length === 0 && live.failedProviders.size > 0) {
      return {
        enabled: true,
        mode: 'unavailable',
        liveProvidersEnabled,
        deployments: [],
        providerError,
      };
    }

    // Answered — possibly with an empty list, which is a real answer and must
    // not fall through to the fixtures.
    return {
      enabled: true,
      mode: 'live',
      liveProvidersEnabled,
      deployments: live.items,
      providerError,
    };
  }

  /**
   * Fetches deploy history from every target's provider.
   *
   * Reports what was attempted and what failed rather than collapsing both
   * into an empty list, so the caller can tell "nothing to show" apart from
   * "could not reach the provider".
   */
  private async fetchLiveDeployments(
    targets: DeploymentTargetSummary[],
    userId: string,
  ): Promise<{
    items: ProjectDeploymentHistoryItem[];
    attempted: number;
    failedProviders: Set<string>;
  }> {
    const items: ProjectDeploymentHistoryItem[] = [];
    const failedProviders = new Set<string>();
    let attempted = 0;

    if (this.clientRegistry) {
      for (const target of targets) {
        const outcome = await this.fetchTargetDeployments(target, userId);
        items.push(...outcome.items);
        if (outcome.attempted) attempted += 1;
        if (outcome.failedProvider) failedProviders.add(outcome.failedProvider);
      }
    }

    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { items, attempted, failedProviders };
  }

  /**
   * A message naming the providers that failed, safe to show to the reader.
   *
   * Deliberately does not carry the provider's own error text: that can hold
   * a URL or a token fragment. The detail is logged instead.
   */
  private providerErrorMessage(failedProviders: Set<string>): string | null {
    if (failedProviders.size === 0) {
      return null;
    }

    const names = [...failedProviders]
      .map((provider) => this.providerLabel(provider))
      .sort();
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

    return `Could not reach ${list} to load deployment history. The list may be incomplete.`;
  }

  private providerLabel(provider: string): string {
    return (
      this.providerRegistry?.find(provider)?.label ??
      provider
        .replace(/[-_]+/g, ' ')
        .replace(/^./, (first) => first.toUpperCase())
    );
  }

  private async fetchTargetDeployments(
    target: DeploymentTargetSummary,
    userId: string,
  ): Promise<TargetFetchOutcome> {
    const skipped: TargetFetchOutcome = {
      items: [],
      attempted: false,
      failedProvider: null,
    };

    if (!this.clientRegistry || !target.providerProjectId?.trim()) {
      return skipped;
    }
    const client = this.clientRegistry.getClient(target.provider);
    if (!client.getDeployHistory) {
      return skipped;
    }

    try {
      // Resolving the token is part of "is this connected at all", not part
      // of the request, so a missing one is a skip rather than a failure.
      const token = await this.resolveProviderToken(target, userId);
      if (!token) return skipped;
      const events = await client.getDeployHistory({
        token,
        targetId: target.providerProjectId,
        ...this.providerOperationInput(target),
      });
      const items = events.map((event) => ({
        id: event.id,
        targetId: target.id,
        targetName: target.providerProjectName,
        provider: target.provider,
        // The provider's own lane wins when it reports one; the target's
        // configured Render environment is the fallback for providers that
        // don't distinguish production from preview.
        environment: event.environment ?? target.renderEnvironmentName ?? null,
        // Likewise: Vercel names the branch on the deployment itself, Render
        // only knows the branch the target tracks.
        branch: event.commitRef ?? target.branchName,
        commitSha: event.commitSha,
        commitMessage: event.commitMessage,
        status: this.provider.normalizeStatus(event.status),
        createdAt: event.createdAt,
        readyAt: event.readyAt,
        // Per-deployment hostname where the provider issues one, otherwise
        // the target's stable public URL.
        deploymentUrl:
          event.deploymentUrl ??
          this.providerRegistry
            ?.find(target.provider)
            ?.presentation?.publicUrl(
              this.presentationTarget(target),
              event.environment === 'production' || target.branchName === 'main'
                ? 'production'
                : 'preview',
            ) ??
          null,
        pullRequestNumber: event.pullRequestNumber,
        inspectorUrl: event.inspectorUrl,
        dashboardUrl: this.provider.dashboardUrl(target),
        consoleUrl: this.provider.consoleUrl(target),
      }));

      return { items, attempted: true, failedProvider: null };
    } catch (error) {
      // Other targets still get their turn, but the failure is reported
      // rather than swallowed: an unreported one reached the reader as
      // "no provider integration is connected yet", which sent people to
      // reconnect a working integration during a provider outage.
      this.logger.warn(
        `Deploy history unavailable for target ${target.id} on ${target.provider}: ${this.sanitizeError(error)}`,
      );
      return { items: [], attempted: true, failedProvider: target.provider };
    }
  }

  /** Strips credentials before a provider message reaches the log. */
  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
  }

  private presentationTarget(target: DeploymentTargetSummary) {
    return {
      providerProjectId: target.providerProjectId,
      providerProjectName: target.providerProjectName,
      providerMetadata: target.providerMetadata,
      branchName: target.branchName,
    };
  }

  private providerOperationInput(
    target: DeploymentTargetSummary,
  ): Record<string, unknown> {
    const policy = this.providerRegistry?.find(target.provider)?.policy;
    if (!policy) {
      return {};
    }
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return policy.resolveOperationInput({
      ownershipMode: target.ownershipMode,
      providerMetadata: target.providerMetadata,
      managedConfig: config?.envProvisioning.flowciManaged ?? {},
    });
  }

  private async resolveProviderToken(
    target: DeploymentTargetSummary,
    userId: string,
  ): Promise<string | null> {
    if (target.ownershipMode === 'flowci_managed') {
      const config = this.configService?.getOrThrow<AppConfig>('app');
      const managedConfig = config?.envProvisioning.flowciManaged as unknown as
        | Record<string, unknown>
        | undefined;
      const token = managedConfig?.[`${target.provider}Token`];
      return typeof token === 'string' && token.trim() ? token.trim() : null;
    }

    if (
      !target.providerConnectionId ||
      !this.providerConnectionsRepository ||
      !this.encryptionService
    ) {
      return null;
    }
    const connection =
      await this.providerConnectionsRepository.findActiveProviderConnection(
        target.providerConnectionId,
        userId,
      );
    if (!connection || connection.provider !== target.provider) {
      return null;
    }

    return this.encryptionService.decrypt(connection.encryptedToken);
  }

  private enabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.deploymentHistory?.enabled ?? false;
  }

  private liveProvidersEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.deploymentHistory?.liveProvidersEnabled ?? true;
  }
}
