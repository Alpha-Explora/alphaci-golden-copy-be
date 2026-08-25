import { Inject, Injectable, Optional } from '@nestjs/common';

import type { DeploymentTargetSummary } from '../core/deployments.types';
import { providerPublicUrl } from '../core/provider-public-url';
import type { DeploymentHistoryStatus } from '../core/deployment-provisioning.contract';
import type { ProjectDeploymentHistoryItem } from './project-deployments.types';

export const LOCAL_DEPLOYMENT_HISTORY_OPTIONS =
  'LOCAL_DEPLOYMENT_HISTORY_OPTIONS';

export interface LocalDeploymentHistoryProviderOptions {
  fixtureMode?: boolean;
}

@Injectable()
export class LocalDeploymentHistoryProvider {
  private readonly fixtureMode: boolean;

  constructor(
    @Optional()
    @Inject(LOCAL_DEPLOYMENT_HISTORY_OPTIONS)
    options: LocalDeploymentHistoryProviderOptions = {},
  ) {
    this.fixtureMode =
      options.fixtureMode ??
      process.env['DEPLOYMENT_HISTORY_LOCAL_FIXTURES_ENABLED'] === 'true';
  }

  listDeployments(
    targets: DeploymentTargetSummary[],
  ): Promise<ProjectDeploymentHistoryItem[]> {
    if (!this.fixtureMode) {
      return Promise.resolve([]);
    }

    const now = '2026-06-12T00:00:00.000Z';
    const deployments: ProjectDeploymentHistoryItem[] = targets.map(
      (target) => ({
        id: `local-${target.id}`,
        targetId: target.id,
        targetName: target.providerProjectName,
        provider: target.provider,
        environment: target.renderEnvironmentName ?? null,
        branch: target.branchName,
        commitSha: null,
        commitMessage: null,
        status: 'ready' as const,
        createdAt: now,
        readyAt: now,
        deploymentUrl: providerPublicUrl(target),
        // The fixture feed stands in for provider history that hasn't been
        // connected yet, so it has no pull request or per-deployment console
        // to point at.
        pullRequestNumber: null,
        inspectorUrl: null,
        dashboardUrl: this.dashboardUrl(target),
        consoleUrl: this.consoleUrl(target),
      }),
    );
    return Promise.resolve(deployments);
  }

  normalizeStatus(status: string | null | undefined): DeploymentHistoryStatus {
    const normalized = status?.toLowerCase() ?? '';
    if (['queued', 'pending', 'created'].includes(normalized)) return 'queued';
    if (
      ['building', 'build_in_progress', 'in_progress', 'initializing'].includes(
        normalized,
      )
    ) {
      return 'building';
    }
    if (['ready', 'live', 'succeeded', 'success'].includes(normalized)) {
      return 'ready';
    }
    if (['failed', 'error', 'build_failed'].includes(normalized)) {
      return 'failed';
    }
    if (['canceled', 'cancelled'].includes(normalized)) return 'canceled';
    return 'unknown';
  }

  dashboardUrl(target: DeploymentTargetSummary): string {
    if (target.provider === 'vercel') {
      const teamSlug =
        typeof target.providerMetadata['vercelTeamSlug'] === 'string'
          ? target.providerMetadata['vercelTeamSlug'].trim()
          : '';
      return teamSlug
        ? `https://vercel.com/${teamSlug}/${target.providerProjectName}`
        : `https://vercel.com/dashboard/project/${target.providerProjectId}`;
    }

    return `https://dashboard.render.com/web/${target.providerProjectId}`;
  }

  consoleUrl(target: DeploymentTargetSummary): string {
    if (target.provider === 'vercel') {
      const teamSlug =
        typeof target.providerMetadata['vercelTeamSlug'] === 'string'
          ? target.providerMetadata['vercelTeamSlug'].trim()
          : '';
      return teamSlug
        ? `https://vercel.com/${teamSlug}/${target.providerProjectName}/deployments`
        : `https://vercel.com/dashboard/project/${target.providerProjectId}/deployments`;
    }

    return `https://dashboard.render.com/web/${target.providerProjectId}/logs`;
  }
}
