import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import { ProjectDeploymentsService } from './project-deployments.service';
import type { ProjectDeploymentHistoryItem } from './project-deployments.types';
import type {
  ProjectBranchPreview,
  ProjectPreviewsResponse,
} from './project-previews.types';
import { UrlEmbeddabilityProbe } from './url-embeddability.probe';

@Injectable()
export class ProjectPreviewsService {
  constructor(
    private readonly deploymentsService: ProjectDeploymentsService,
    private readonly embeddabilityProbe: UrlEmbeddabilityProbe,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /**
   * Per-branch previews, newest deployment per branch.
   *
   * Deliberately built on top of ProjectDeploymentsService rather than issuing
   * its own provider calls: the deployment history and this view want the same
   * upstream data, and Vercel's API is rate limited, so a second independent
   * fetch would double the request count for the same screen.
   */
  async listPreviews(
    projectId: string,
    userId: string,
  ): Promise<ProjectPreviewsResponse> {
    if (!this.enabled()) {
      return { enabled: false, liveProvidersEnabled: false, branches: [] };
    }

    const history = await this.deploymentsService.listDeployments(
      projectId,
      userId,
    );

    const newestPerBranch = this.newestPerBranch(history.deployments);
    const branches = await Promise.all(
      newestPerBranch.map((deployment) => this.toBranchPreview(deployment)),
    );

    return {
      enabled: true,
      liveProvidersEnabled: history.liveProvidersEnabled,
      // Production first, then the most recently deployed branch, so the
      // branch someone just pushed surfaces near the top.
      branches: branches.sort(comparePreviews),
    };
  }

  /**
   * One entry per (target, branch) pair. Two targets can deploy the same
   * branch — a frontend and a backend slot on the same repo — and those are
   * genuinely different previews, so the target is part of the key.
   */
  private newestPerBranch(
    deployments: ProjectDeploymentHistoryItem[],
  ): ProjectDeploymentHistoryItem[] {
    const newest = new Map<string, ProjectDeploymentHistoryItem>();

    for (const deployment of deployments) {
      if (!deployment.branch) {
        // Without a branch there is nothing to group under; it still shows in
        // the deployment history, just not here.
        continue;
      }

      const key = `${deployment.targetId}::${deployment.branch}`;
      const existing = newest.get(key);
      if (!existing || isNewer(deployment, existing)) {
        newest.set(key, deployment);
      }
    }

    return [...newest.values()];
  }

  private async toBranchPreview(
    deployment: ProjectDeploymentHistoryItem,
  ): Promise<ProjectBranchPreview> {
    // Only probe something worth framing. A build that failed or is still
    // running has no page to show yet, and probing it would spend a request
    // to learn nothing.
    const verdict =
      deployment.status === 'ready'
        ? await this.embeddabilityProbe.check(deployment.deploymentUrl)
        : { embeddable: null, reason: null };

    return {
      branch: deployment.branch as string,
      isProduction: deployment.environment === 'production',
      deploymentId: deployment.id,
      targetId: deployment.targetId,
      targetName: deployment.targetName,
      provider: deployment.provider,
      status: deployment.status,
      commitSha: deployment.commitSha,
      commitMessage: deployment.commitMessage,
      pullRequestNumber: deployment.pullRequestNumber,
      previewUrl: deployment.deploymentUrl,
      inspectorUrl: deployment.inspectorUrl,
      createdAt: deployment.createdAt,
      readyAt: deployment.readyAt,
      embeddable: verdict.embeddable,
      embedBlockedReason: verdict.reason,
    };
  }

  private enabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.previewDeployments?.enabled ?? false;
  }
}

function isNewer(
  candidate: ProjectDeploymentHistoryItem,
  incumbent: ProjectDeploymentHistoryItem,
): boolean {
  return Date.parse(candidate.createdAt) > Date.parse(incumbent.createdAt);
}

function comparePreviews(
  a: ProjectBranchPreview,
  b: ProjectBranchPreview,
): number {
  if (a.isProduction !== b.isProduction) {
    return a.isProduction ? -1 : 1;
  }
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}
