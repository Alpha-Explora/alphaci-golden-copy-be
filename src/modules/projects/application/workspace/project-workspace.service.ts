import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';

import { QA_PROMOTION_TARGET_BRANCH } from '#kernel/config/pipeline-branches';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import type {
  GitHubBranchComparison,
  GitHubBranchSummary,
  GitHubContentListing,
  GitHubPullRequestCheck,
  GitHubPullRequestDetail,
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubRunJob,
  GitHubWorkflowRunSummary,
} from '#kernel/ports/github.port';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  canCreatePullRequest,
  canMergeViaWorkspace,
} from '#kernel/rules/persona-access.rules';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { extractFailureExcerpt } from './extract-failure-excerpt';

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
 * The GitHub views behind a project's Code, Pull requests and Pipeline runs
 * tabs, and the pull-request actions taken from them.
 *
 * Everything here answers for ONE project and is scoped by the same ownership
 * check the rest of the project API uses: `findByIdAndUser` returns nothing for
 * a project the caller cannot see, which becomes a 404 rather than a 403 — a
 * project you may not read should not confirm its own existence.
 *
 * ALPHACI is where people work; GitHub is where the work is stored. Pull
 * requests are opened here, but they are real GitHub pull requests, because a
 * branch protection rule only counts reviews and merges GitHub knows about.
 * Reads and writes resolve their token differently — see `context` and
 * `writeContext`.
 */

/**
 * The failing job's error output, or why there is none to show.
 *
 * `available: false` is a normal answer, not an error: GitHub expires logs, and
 * a run can conclude in failure with no failed job when it was the workflow
 * itself that was rejected.
 */
export interface ProjectRunFailureLogResponse {
  available: boolean;
  reason?: 'no-failed-job' | 'log-expired';
  jobName?: string;
  stepName?: string;
  jobUrl?: string;
  lines?: string[];
  truncated?: boolean;
  foundErrorMarker?: boolean;
}

/**
 * One pull request, its checks, and whether the system may merge it.
 *
 * Assembled here rather than in the browser because it takes three GitHub
 * reads and a token the browser must never hold.
 */
export interface ProjectPullRequestDetailResponse {
  repoFullName: string;
  pullRequest: GitHubPullRequestDetail;
  checks: GitHubPullRequestCheck[];
  /**
   * True when the viewer opened the pull request themselves.
   *
   * GitHub refuses to let anyone approve their own pull request, so the UI
   * must not offer an approve action that can only fail. Computed server-side
   * because only the server knows which GitHub login the session belongs to.
   */
  viewerIsAuthor: boolean;
}

/** What happened when the system asked GitHub to merge. */
export interface ProjectPullRequestMergeResponse {
  merged: boolean;
  message: string;
  sha: string | null;
}

/**
 * Everything the compose screen shows before a pull request exists.
 *
 * `existingPullRequest` is here so the screen can say "this is already open as
 * #12" before someone writes a description GitHub would then refuse.
 */
export interface ProjectBranchComparisonResponse {
  repoFullName: string;
  base: string;
  head: string;
  comparison: GitHubBranchComparison;
  existingPullRequest: GitHubPullRequestSummary | null;
}

export interface ProjectPullRequestCreateInput {
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}

/** A refusal is `created: false` with GitHub's sentence, not an error. */
export type ProjectPullRequestCreateResponse =
  | { created: true; pullRequest: GitHubPullRequestSummary }
  | { created: false; message: string };

@Injectable()
export class ProjectWorkspaceService {
  private readonly logger = new Logger(ProjectWorkspaceService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
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
   * The error output of whichever job failed in a run.
   *
   * This exists so the product can show the failure instead of telling someone
   * to go and read it on GitHub. A hint that says "open the workflow logs" is
   * an admission that the system knows a stage failed and will not say why.
   *
   * Three calls happen server-side — jobs, then that job's log, then the
   * excerpt — because doing it in the browser would mean shipping a GitHub
   * token to it. Never polled: it is reached only when someone asks to see the
   * error, in keeping with the workspace read contract at the top of the
   * controller.
   */
  async getRunFailureLog(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    runId: number,
  ): Promise<ProjectRunFailureLogResponse> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );

    const jobs = await this.githubService.getWorkflowRunJobs(
      token,
      repoFullName,
      runId,
    );

    const failed = jobs.find(
      (job) => job.conclusion === 'failure' || job.conclusion === 'timed_out',
    );

    if (!failed) {
      return { available: false, reason: 'no-failed-job' };
    }

    // The step is named separately because the job name alone is often a
    // reusable-workflow path like "sonar / SonarCloud .NET Analysis", which
    // says which check ran but not which part of it gave up.
    const failedStep = failed.steps.find(
      (step) =>
        step.conclusion === 'failure' || step.conclusion === 'timed_out',
    );

    const log = await this.githubService.getJobLogs(
      token,
      repoFullName,
      failed.id,
    );

    if (!log) {
      return {
        available: false,
        reason: 'log-expired',
        jobName: failed.name,
        ...(failedStep && { stepName: failedStep.name }),
        ...(failed.htmlUrl && { jobUrl: failed.htmlUrl }),
      };
    }

    const excerpt = extractFailureExcerpt(log.content);

    return {
      available: true,
      jobName: failed.name,
      ...(failedStep && { stepName: failedStep.name }),
      ...(failed.htmlUrl && { jobUrl: failed.htmlUrl }),
      lines: excerpt.lines,
      truncated: excerpt.truncated || log.truncated,
      foundErrorMarker: excerpt.foundErrorMarker,
    };
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

  /**
   * One pull request with everything needed to decide about it.
   *
   * This exists so a person does not have to leave for GitHub to answer "is it
   * safe to merge": the checks and the mergeable state are the two things that
   * question turns on, and neither is in the list response.
   */
  async getPullRequestDetail(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    pullNumber: number,
    viewerLogin: string | null,
  ): Promise<ProjectPullRequestDetailResponse> {
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );

    const pullRequest = await this.githubService.getPullRequest(
      token,
      repoFullName,
      pullNumber,
    );

    if (!pullRequest) {
      throw new NotFoundException(
        `Pull request #${String(pullNumber)} was not found in ${repoFullName}.`,
      );
    }

    // No head sha means GitHub gave us an incomplete row; ask for no checks
    // rather than for the checks of an empty ref.
    const checks = pullRequest.headSha
      ? await this.githubService.getPullRequestChecks(
          token,
          repoFullName,
          pullRequest.headSha,
        )
      : [];

    return {
      repoFullName,
      pullRequest,
      checks,
      // Taken from the session rather than from GitHub: an installation token
      // identifies the app, not the person holding it, so asking GitHub who
      // "we" are would answer the bot and never match the author.
      viewerIsAuthor:
        viewerLogin != null &&
        pullRequest.author != null &&
        viewerLogin === pullRequest.author,
    };
  }

  /**
   * Merge a pull request from inside the product.
   *
   * A refusal comes back as `merged: false` with GitHub's own sentence, rather
   * than as an error: "at least 1 approving review is required" is an answer,
   * and the point of merging here instead of on GitHub is that the product
   * repeats what GitHub said rather than a shrug.
   *
   * Merged with the caller's own token, like opening one. It used to go
   * through the App token, which had two faults: GitHub recorded the bot as
   * the person who merged, and anyone who could merely SEE the project could
   * merge into its protected branches through the App's write access. With
   * the person's token, GitHub checks their own permission on the repository.
   *
   * Gated on the pull request's own base branch and the caller's global
   * persona (see persona-access.rules.ts): merging into the production
   * branch is never allowed here, for any role — that happens only through
   * QA Studio's "Ready for production" gate (qa-promotion.service.ts). For
   * every other base, only admin/lead/member may merge; qa never merges a
   * pull request. The base is read fresh from GitHub on every call rather
   * than trusted from a prior list/detail read, the same reasoning
   * QaPromotionService.merge already applies to uat's head sha.
   */
  async mergePullRequest(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    pullNumber: number,
    method: 'merge' | 'squash' | 'rebase',
  ): Promise<ProjectPullRequestMergeResponse> {
    const { repoFullName, token } = await this.writeContext(
      projectId,
      userId,
      oauthToken,
      'merge pull requests',
    );

    const pullRequest = await this.githubService.getPullRequest(
      token,
      repoFullName,
      pullNumber,
    );
    if (!pullRequest) {
      throw new NotFoundException(
        `Pull request #${String(pullNumber)} was not found in ${repoFullName}.`,
      );
    }

    if (pullRequest.baseRef === QA_PROMOTION_TARGET_BRANCH) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MAIN_MERGE_VIA_QA_STUDIO',
        message:
          'Merges into main go through QA Studio (Ready for production).',
      });
    }

    const role = await this.projectsRepository.findAppRole(userId);
    if (!canMergeViaWorkspace(role, pullRequest.baseRef)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PR_ROLE_FORBIDDEN',
        message: 'Your role cannot merge pull requests in this project.',
      });
    }

    const result = await this.githubService.mergePullRequest(
      token,
      repoFullName,
      pullNumber,
      { method },
    );

    if (result.merged) {
      await this.auditEventPublisher?.recordProjectEvent({
        actorUserId: userId,
        projectId,
        eventCode: 'pull_request_merged',
        message: `Pull request #${String(pullNumber)} merged (${method})`,
        metadata: { pullRequestNumber: pullNumber, method, sha: result.sha },
      });
    }

    return result;
  }

  /**
   * What a pull request from `head` into `base` would contain.
   *
   * Read with the same token as every other workspace read: nothing is written
   * yet, so there is no author to get right. Reached only when someone opens
   * the compose screen or changes a branch in it, never polled.
   */
  async compareBranches(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    base: string,
    head: string,
  ): Promise<ProjectBranchComparisonResponse> {
    this.requireDistinctBranches(base, head);
    const { repoFullName, token } = await this.context(
      projectId,
      userId,
      oauthToken,
    );

    const [comparison, existingPullRequest] = await Promise.all([
      this.githubService.compareBranches(token, repoFullName, base, head),
      this.githubService.findOpenPullRequest(token, repoFullName, head, base),
    ]);

    if (!comparison) {
      throw new NotFoundException(
        `Branch '${base}' or '${head}' does not exist in ${repoFullName}.`,
      );
    }

    return { repoFullName, base, head, comparison, existingPullRequest };
  }

  /**
   * Open a pull request as the person asking.
   *
   * Uses the caller's own GitHub token, never the App's: the pull request must
   * be authored by the person, or GitHub would list the bot as its author and
   * let that person approve their own change. It also makes GitHub the judge
   * of who may open one — a caller without write access to the repository is
   * refused by GitHub, and that refusal is passed back as its sentence.
   *
   * Gated on `input.base` and the caller's global persona (see
   * persona-access.rules.ts): a pull request into the production branch is
   * never opened here, for any role — main is reached only by the promotion
   * flow and merged from QA Studio. For every other base, only
   * admin/lead/member may open one; qa never opens a pull request.
   */
  async createPullRequest(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    input: ProjectPullRequestCreateInput,
  ): Promise<ProjectPullRequestCreateResponse> {
    const title = input.title.trim();
    if (!title) {
      throw new BadRequestException('A pull request needs a title.');
    }
    this.requireDistinctBranches(input.base, input.head);

    const { repoFullName, token } = await this.writeContext(
      projectId,
      userId,
      oauthToken,
    );

    if (input.base === QA_PROMOTION_TARGET_BRANCH) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MAIN_PR_RESTRICTED',
        message:
          'Pull requests into main are opened by the promotion flow and merged from QA Studio.',
      });
    }

    const role = await this.projectsRepository.findAppRole(userId);
    if (!canCreatePullRequest(role, input.base)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PR_ROLE_FORBIDDEN',
        message: 'Your role cannot open pull requests in this project.',
      });
    }

    const result = await this.githubService.openPullRequest(
      token,
      repoFullName,
      {
        title,
        base: input.base,
        head: input.head,
        ...(input.body?.trim() ? { body: input.body } : {}),
        draft: input.draft === true,
      },
    );

    if (result.created) {
      await this.auditEventPublisher?.recordProjectEvent({
        actorUserId: userId,
        projectId,
        eventCode: 'pull_request_created',
        message: `Pull request #${String(result.pullRequest.number)} opened: ${input.head} → ${input.base}`,
        metadata: {
          pullRequestNumber: result.pullRequest.number,
          pullRequestUrl: result.pullRequest.htmlUrl,
          base: input.base,
          head: input.head,
          draft: input.draft === true,
        },
      });
    }

    return result;
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
   * Resolve the project and the CALLER'S OWN token, for anything that writes.
   *
   * Deliberately no installation-token fallback. `context` prefers the App
   * token because it is the better credential for reading; for writing it is
   * the wrong one, because GitHub records whoever holds the token as the
   * author. A write that silently fell back to the App would be attributed to
   * the bot, which is worse than refusing.
   */
  private async writeContext(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    /** What the caller was trying to do, for the sign-in-expired sentence. */
    action = 'open pull requests',
  ): Promise<{ repoFullName: string; token: string }> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    if (!oauthToken) {
      throw new UnauthorizedException(
        `Your GitHub sign-in has expired. Sign in again to ${action}.`,
      );
    }

    return { repoFullName: row.repo_full_name, token: oauthToken };
  }

  /**
   * A pull request from a branch into itself is empty by definition. Refused
   * before any GitHub call so the answer does not cost rate limit.
   */
  private requireDistinctBranches(base: string, head: string): void {
    if (base === head) {
      throw new BadRequestException(
        'Choose two different branches to compare.',
      );
    }
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
