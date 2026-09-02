import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import type {
  GitHubBranchSummary,
  GitHubContentListing,
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubRunJob,
  GitHubWorkflowRunSummary,
} from '#kernel/ports/github.port';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { ProjectsRepository } from '../../infrastructure/projects.repository';

export interface ProjectBranchesResponse {
  defaultBranch: string;
  branches: GitHubBranchSummary[];
}

export interface ProjectWorkflowRunsResponse {
  repoFullName: string;
  actionsUrl: string;
  runs: GitHubWorkflowRunSummary[];
}

export interface ProjectPullRequestsResponse {
  repoFullName: string;
  pullsUrl: string;
  pullRequests: GitHubPullRequestSummary[];
}

export interface ProjectJobLogResponse {
  available: boolean;
  content: string;
  truncated: boolean;
}

/**
 * The read-only GitHub views behind a project's Code, Pull requests and
 * Pipeline runs tabs.
 *
 * Everything here answers for ONE project and is scoped by the same ownership
 * check the rest of the project API uses: `findByIdAndUser` returns nothing for
 * a project the caller cannot see, which becomes a 404 rather than a 403 — a
 * project you may not read should not confirm its own existence.
 *
 * No writes. Creating branches, opening pull requests and merging all remain
 * GitHub's job; this exists so that reading a project does not require leaving
 * the product, not so that ALPHACI becomes a second GitHub.
 */
@Injectable()
export class ProjectWorkspaceService {
  private readonly logger = new Logger(ProjectWorkspaceService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
  ) {}

  async listBranches(
    projectId: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<ProjectBranchesResponse> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );
    const branches = await this.githubService.listBranches(token, repoFullName);

    return {
      defaultBranch: this.pickDefaultBranch(branches),
      branches,
    };
  }

  /**
   * Browse the repository at a ref.
   *
   * `ref` is optional because the first render has nothing to base it on: the
   * branch list has not loaded yet on a cold open. Resolving it here costs one
   * extra call on that first request only, and saves the browser a round trip
   * it would otherwise have to make before it could ask for anything.
   */
  async listFiles(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    path: string,
    ref: string | null,
  ): Promise<GitHubContentListing> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );

    const resolvedRef =
      ref ??
      this.pickDefaultBranch(
        await this.githubService.listBranches(token, repoFullName),
      );

    return this.githubService.listRepoContents(
      token,
      repoFullName,
      path,
      resolvedRef,
    );
  }

  async listWorkflowRuns(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    branch: string | null,
  ): Promise<ProjectWorkflowRunsResponse> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );

    return {
      repoFullName,
      actionsUrl: `https://github.com/${repoFullName}/actions`,
      runs: await this.githubService.listWorkflowRuns(
        token,
        repoFullName,
        branch,
      ),
    };
  }

  async getRunJobs(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    runId: number,
  ): Promise<GitHubRunJob[]> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );
    return this.githubService.getWorkflowRunJobs(token, repoFullName, runId);
  }

  /**
   * A job's console output.
   *
   * A missing log is reported as `available: false` rather than as a 404: an
   * expired log is a normal state of an old run, and the tab should say so in
   * place of the console instead of showing an error.
   */
  async getJobLog(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    jobId: number,
  ): Promise<ProjectJobLogResponse> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );

    const log = await this.githubService.getJobLogs(token, repoFullName, jobId);

    if (!log) {
      return { available: false, content: '', truncated: false };
    }

    return { available: true, content: log.content, truncated: log.truncated };
  }

  async listPullRequests(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    state: 'open' | 'closed' | 'all',
  ): Promise<ProjectPullRequestsResponse> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );

    return {
      repoFullName,
      pullsUrl: `https://github.com/${repoFullName}/pulls`,
      pullRequests: await this.githubService.listPullRequests(
        token,
        repoFullName,
        state,
      ),
    };
  }

  async getPullRequestFiles(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    pullNumber: number,
  ): Promise<GitHubPullRequestFile[]> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );
    return this.githubService.getPullRequestFiles(
      token,
      repoFullName,
      pullNumber,
    );
  }

  /**
   * Resolve the project and a token that can read it, in that order.
   *
   * The project lookup comes FIRST so that a caller who cannot see the project
   * gets "not found" without us having minted a token for a repository they
   * have no claim to.
   */
  private async context(
    projectId: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<{ repoFullName: string; token: string }> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    // The installation token is preferred over the caller's OAuth token: it is
    // scoped to the repository rather than to everything the person can reach,
    // and it keeps working when their OAuth grant lapses.
    //
    // The enforced org is resolved first and app-to-org, because the per-user
    // lookup below reads github_app.github_installations — a table populated
    // by this product's own linking flow and by `installation` webhooks. An
    // App installed directly on GitHub is real to GitHub and absent from that
    // table, so the per-user lookup returned null, every read fell through to
    // OAuth, and each workspace tab reported the repository as unreadable
    // while the project itself had provisioned fine.
    const token =
      (await this.enforcedOrgToken(row.repo_full_name)) ??
      (await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        row.repo_full_name,
      )) ??
      oauthToken;

    if (!token) {
      throw new UnauthorizedException(
        'No usable GitHub token found. Link the GitHub App installation or re-authenticate via GitHub OAuth.',
      );
    }

    return { repoFullName: row.repo_full_name, token };
  }

  /**
   * Installation token for the enforced org, resolved straight from GitHub.
   *
   * Returns null when no org is enforced or the repository belongs to a
   * different owner, so a repository outside the enforced org still resolves
   * through the per-user installation and then OAuth. A failure here is also
   * null rather than a throw: the remaining strategies may still succeed, and
   * an unreachable App should not turn a readable repository into an error.
   */
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

  /**
   * Which branch to open on.
   *
   * GitHub's branch list does not say which branch is the default, and asking
   * the repository endpoint for it would be a second call on every cold open.
   * These three names cover every repository this product creates; anything
   * else falls back to the first branch, which is the best available guess and
   * never empty when the list is non-empty.
   */
  private pickDefaultBranch(branches: GitHubBranchSummary[]): string {
    const preferred = ['main', 'master', 'develop'];
    for (const name of preferred) {
      if (branches.some((branch) => branch.name === name)) return name;
    }
    return branches[0]?.name ?? 'main';
  }
}
