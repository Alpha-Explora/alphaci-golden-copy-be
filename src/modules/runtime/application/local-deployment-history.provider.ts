import { Inject, Injectable, Optional } from '@nestjs/common';

import type { DeploymentTargetSummary } from '../core/deployments.types';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import type { DeploymentProvider } from '../core/deployment-provider.contract';
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
    @Optional()
    private readonly providerRegistry?: DeploymentProviderRegistry<DeploymentProvider>,
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
        createdBy: null,
        status: 'ready' as const,
        createdAt: now,
        readyAt: now,
        deploymentUrl: this.publicUrl(target),
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
    const presentation = this.providerPresentation(target);
    if (presentation) {
      return presentation.dashboardUrl(this.presentationTarget(target)) ?? '';
    }
    return '';
  }

  consoleUrl(target: DeploymentTargetSummary): string {
    const presentation = this.providerPresentation(target);
    if (presentation) {
      return presentation.consoleUrl(this.presentationTarget(target)) ?? '';
    }
    return '';
  }

  publicUrl(target: DeploymentTargetSummary): string | null {
    const presentation = this.providerPresentation(target);
    return (
      presentation?.publicUrl(
        this.presentationTarget(target),
        target.renderEnvironmentName === 'production' ||
          target.branchName === 'main'
          ? 'production'
          : 'preview',
      ) ?? null
    );
  }

  private providerPresentation(target: DeploymentTargetSummary) {
    try {
      return this.providerRegistry?.get(target.provider).presentation;
    } catch {
      return undefined;
    }
  }

  private presentationTarget(target: DeploymentTargetSummary) {
    return {
      providerProjectId: target.providerProjectId,
      providerProjectName: target.providerProjectName,
      providerMetadata: target.providerMetadata,
      branchName: target.branchName,
    };
  }
}
