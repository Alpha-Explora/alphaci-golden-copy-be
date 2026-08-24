import { Injectable, NotFoundException, Optional } from '@nestjs/common';
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

export interface ProjectDeploymentsResponse {
  enabled: boolean;
  mode: 'local_mock' | 'live';
  liveProvidersEnabled: boolean;
  deployments: ProjectDeploymentHistoryItem[];
}

@Injectable()
export class ProjectDeploymentsService {
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
      };
    }

    const targets =
      await this.deploymentTargetsRepository.listDeploymentTargets(projectId);

    const liveDeployments = await this.fetchLiveDeployments(targets, userId);
    if (liveDeployments) {
      return {
        enabled: true,
        mode: 'live',
        liveProvidersEnabled: this.liveProvidersEnabled(),
        deployments: liveDeployments,
      };
    }

    return {
      enabled: true,
      mode: 'local_mock',
      liveProvidersEnabled: this.liveProvidersEnabled(),
      deployments: await this.provider.listDeployments(targets),
    };
  }

  /**
   * Best-effort: fetches real deploy history from each target's provider.
   * Returns null (falling back to the local mock feed) unless at least one
   * target actually produced live events — a target with no resolvable
   * token or no deploy history support is skipped, not treated as failure.
   */
  private async fetchLiveDeployments(
    targets: DeploymentTargetSummary[],
    userId: string,
  ): Promise<ProjectDeploymentHistoryItem[] | null> {
    if (!this.clientRegistry || targets.length === 0) {
      return null;
    }

    const items: ProjectDeploymentHistoryItem[] = [];
    for (const target of targets) {
      const targetItems = await this.fetchTargetDeployments(target, userId);
      items.push(...targetItems);
    }

    return items.length > 0
      ? items.sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        )
      : null;
  }

  private async fetchTargetDeployments(
    target: DeploymentTargetSummary,
    userId: string,
  ): Promise<ProjectDeploymentHistoryItem[]> {
    if (!this.clientRegistry || !target.providerProjectId?.trim()) {
      return [];
    }
    const client = this.clientRegistry.getClient(target.provider);
    if (!client.getDeployHistory) {
      return [];
    }

    try {
      const token = await this.resolveProviderToken(target, userId);
      if (!token) return [];
      const events = await client.getDeployHistory({
        token,
        targetId: target.providerProjectId,
        ...this.vercelScopeFor(target),
      });
      return events.map((event) => ({
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
    } catch {
      // This target's live history is unavailable — fall through and let
      // other targets still contribute; only an empty overall result
      // triggers the local-mock fallback.
      return [];
    }
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
