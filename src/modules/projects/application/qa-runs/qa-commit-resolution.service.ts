import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  DEPLOYMENT_HISTORY_QUERY,
  type DeploymentHistoryQuery,
  type DeploymentProjectReference,
} from '#kernel/ports/deployment-runtime.port';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import type { QaCommitSource } from './qa-runs.contracts';

export interface QaResolvedCommit {
  commitSha: string;
  commitSource: QaCommitSource;
}

/**
 * Server-authoritative commit resolution for the QA verification-runs
 * slice: the client never supplies a sha, only a branch. Order, per the
 * task contract:
 *   1. the newest READY deployment of that branch that has a commitSha
 *      (via DEPLOYMENT_HISTORY_QUERY — the same port
 *      ProjectPreviewsService/ProjectDeploymentsService use) -> 'deployment';
 *   2. else the GitHub branch head (GithubProjectPort.listBranches) ->
 *      'branch_head';
 *   3. else null — the caller decides what that means (409 for POST create,
 *      a null field for GET current).
 */
@Injectable()
export class QaCommitResolutionService {
  private readonly logger = new Logger(QaCommitResolutionService.name);

  constructor(
    @Inject(DEPLOYMENT_HISTORY_QUERY)
    private readonly deploymentHistory: DeploymentHistoryQuery,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
  ) {}

  async resolve(
    project: DeploymentProjectReference,
    branch: string,
    oauthToken: string | null,
  ): Promise<QaResolvedCommit | null> {
    const fromDeployment = await this.resolveFromDeployment(project, branch);
    if (fromDeployment) {
      return fromDeployment;
    }

    return this.resolveFromBranchHead(project, branch, oauthToken);
  }

  private async resolveFromDeployment(
    project: DeploymentProjectReference,
    branch: string,
  ): Promise<QaResolvedCommit | null> {
    const history = await this.deploymentHistory.listDeployments(project);
    let newest: (typeof history.deployments)[number] | null = null;
    for (const deployment of history.deployments) {
      if (
        deployment.branch !== branch ||
        deployment.status !== 'ready' ||
        !deployment.commitSha
      ) {
        continue;
      }
      if (
        !newest ||
        Date.parse(deployment.createdAt) > Date.parse(newest.createdAt)
      ) {
        newest = deployment;
      }
    }

    return newest?.commitSha
      ? { commitSha: newest.commitSha, commitSource: 'deployment' }
      : null;
  }

  private async resolveFromBranchHead(
    project: DeploymentProjectReference,
    branch: string,
    oauthToken: string | null,
  ): Promise<QaResolvedCommit | null> {
    const token = await this.resolveReadToken(
      project.repoFullName,
      project.userId,
      oauthToken,
    );
    if (!token) {
      return null;
    }

    const branches = await this.githubService.listBranches(
      token,
      project.repoFullName,
    );
    const head = branches.find((candidate) => candidate.name === branch);
    return head
      ? { commitSha: head.commitSha, commitSource: 'branch_head' }
      : null;
  }

  /**
   * Same token precedence as ProjectWorkspaceService's private `context()`
   * (enforced-org installation token, then the per-user-repo installation
   * token, then the caller's own OAuth token) — reimplemented here rather
   * than reused because that method is private to a sibling service. This is
   * a READ (listBranches), so the enforced-org/installation-token
   * preference is correct here for the same reason `context()` documents:
   * it is scoped to the repository and does not depend on the caller's OAuth
   * grant staying valid.
   */
  private async resolveReadToken(
    repoFullName: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<string | null> {
    const enforcedToken = await this.enforcedOrgToken(repoFullName);
    if (enforcedToken) {
      return enforcedToken;
    }

    const installationToken =
      await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        repoFullName,
      );
    if (installationToken) {
      return installationToken;
    }

    return oauthToken;
  }

  private async enforcedOrgToken(repoFullName: string): Promise<string | null> {
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (!enforcedOrg) {
      return null;
    }

    const owner = repoFullName.split('/')[0];
    if (owner?.toLowerCase() !== enforcedOrg.toLowerCase()) {
      return null;
    }

    try {
      const context =
        await this.githubService.getOrganizationProvisioningContextByLogin(
          enforcedOrg,
        );
      return context.accessToken;
    } catch (error) {
      this.logger.warn(
        `Could not resolve the ${enforcedOrg} installation for ${repoFullName}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
