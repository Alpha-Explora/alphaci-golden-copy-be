import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import { DeploymentTargetsRepository } from '../env-provisioning/deployment-targets.repository';
import type { DeploymentTargetSummary } from '../env-provisioning/env-provisioning.types';
import { providerPublicUrl } from '../env-provisioning/index.js';
import { EnvTokenEncryptionService } from '../env-provisioning/encryption.service';
import { ProviderClientRegistry } from '../env-provisioning/provider-clients/provider-client.registry';
import { ProviderConnectionsRepository } from '../env-provisioning/provider-connections.repository';
import { LocalDeploymentHistoryProvider } from './local-deployment-history.provider';
import type { ProjectDeploymentHistoryItem } from './project-deployments.types';
import { ProjectsRepository } from './projects.repository';

/**
 * Where the listed deployments came from.
 *
 * `unavailable` is distinct from `local_mock` on purpose: the first means the
 * provider was asked and did not answer, the second that there was nothing to
 * ask. Collapsing them told the reader their integration was not connected
 * while it was connected and merely failing.
 */
export type DeploymentHistoryMode = 'local_mock' | 'live' | 'unavailable';

export interface ProjectDeploymentsResponse {
  enabled: boolean;
  mode: DeploymentHistoryMode;
  liveProvidersEnabled: boolean;
  deployments: ProjectDeploymentHistoryItem[];
  /**
   * Safe message naming the providers that could not be reached, or null.
   *
   * Set in `live` mode too, where some targets answered and others did not —
   * a partial list is worth showing, but not worth presenting as complete.
   */
  providerError: string | null;
}

/** One target's contribution to the live fetch. */
interface TargetFetchOutcome {
  items: ProjectDeploymentHistoryItem[];
  /** True when a provider request was actually issued. */
  attempted: boolean;
  /** The provider whose request failed, if it did. */
  failedProvider: string | null;
}

@Injectable()
export class ProjectDeploymentsService {
  private readonly logger = new Logger(ProjectDeploymentsService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly deploymentTargetsRepository: DeploymentTargetsRepository,
    private readonly provider: LocalDeploymentHistoryProvider = new LocalDeploymentHistoryProvider(),
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly clientRegistry?: ProviderClientRegistry,
    @Optional()
    private readonly providerConnectionsRepository?: ProviderConnectionsRepository,
    @Optional()
    private readonly encryptionService?: EnvTokenEncryptionService,
  ) {}

  async listDeployments(
    projectId: string,
    userId: string,
  ): Promise<ProjectDeploymentsResponse> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

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
      .map((provider) => (provider === 'vercel' ? 'Vercel' : 'Render'))
      .sort();
    const list =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

    return `Could not reach ${list} to load deployment history. The list may be incomplete.`;
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
        ...this.vercelScopeFor(target),
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
        deploymentUrl: event.deploymentUrl ?? providerPublicUrl(target),
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

  private vercelScopeFor(
    target: DeploymentTargetSummary,
  ): { vercelTeamId?: string; vercelTeamSlug?: string } {
    const teamId = target.providerMetadata['vercelTeamId'];
    const slug = target.providerMetadata['vercelTeamSlug'];
    return {
      ...(typeof teamId === 'string' && teamId.trim()
        ? { vercelTeamId: teamId.trim() }
        : {}),
      ...(typeof slug === 'string' && slug.trim()
        ? { vercelTeamSlug: slug.trim() }
        : {}),
    };
  }

  private async resolveProviderToken(
    target: DeploymentTargetSummary,
    userId: string,
  ): Promise<string | null> {
    if (target.ownershipMode === 'flowci_managed') {
      const config = this.configService?.getOrThrow<AppConfig>('app');
      const token =
        target.provider === 'render'
          ? config?.envProvisioning.flowciManaged.renderToken
          : config?.envProvisioning.flowciManaged.vercelToken;
      return token ?? null;
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
