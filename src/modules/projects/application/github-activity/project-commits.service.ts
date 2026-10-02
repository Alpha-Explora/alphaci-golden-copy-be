import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { PIPELINE_BRANCHES } from '#kernel/config/pipeline-branches';
import {
  GITHUB_PROJECT_PORT,
  type GitHubBranchSummary,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { visibleBranchesFor } from '#kernel/rules/persona-access.rules';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectGithubTokenResolver } from './project-github-token.resolver';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_BRANCHES_LISTED = 20;
const CURSOR_PATTERN = /^page:(\d{1,4})$/;

const SIGN_IN_AGAIN =
  'GitHub no longer accepts your sign-in, which happens when it has been revoked or replaced by a newer one. Sign out and sign in again, then retry.';

export interface ProjectCommitItem {
  sha: string;
  shortSha: string;
  /** First line of the commit message. */
  message: string;
  authorLogin: string | null;
  authorName: string;
  authoredAt: string;
  url: string;
  /** From "(#123)" / "Merge pull request #123" in the message; no API call. */
  pullRequestNumber: number | null;
}

export interface ProjectCommitsResponse {
  branch: string;
  /** dev, uat, main first (when visible), then the rest alphabetically; max 20. */
  branches: string[];
  items: ProjectCommitItem[];
  /** Opaque cursor for `?before=`; null on the last page. */
  next: string | null;
}

export interface ProjectCommitsQuery {
  branch?: string;
  limit?: number;
  before?: string;
}

/** The pull request a commit message names, or null. Exported for tests. */
export function pullRequestNumberFromMessage(firstLine: string): number | null {
  const squash = /\(#(\d+)\)/.exec(firstLine);
  if (squash?.[1]) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+)\b/.exec(firstLine);
  return merge?.[1] ? Number(merge[1]) : null;
}

export function encodeCommitCursor(page: number): string {
  return Buffer.from(`page:${String(page)}`, 'utf8').toString('base64url');
}

export function decodeCommitCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = CURSOR_PATTERN.exec(decoded);
  const page = match?.[1] ? Number(match[1]) : 0;
  if (page < 2) {
    throw new BadRequestException('before is not a valid cursor');
  }
  return page;
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof UnauthorizedException) return true;
  // The branch list reads through the shared workspace helper, which reports
  // every non-404 refusal, 401 included, as a 502 carrying the status.
  return error instanceof BadGatewayException && /\(401\)/.test(error.message);
}

/**
 * GET /projects/:id/commits — the commit history of one branch.
 *
 * Visibility is the project's own (findByIdAndUser, 404 otherwise) and the
 * branches offered are the ones the caller's persona may see in the Code tab
 * (visibleBranchesFor), so this never shows a developer `main`.
 *
 * Token: the caller's own OAuth token first, because this is their view of the
 * repository; if GitHub rejects it (a session token is stored once and goes
 * stale) the installation token is tried; if there is none either, the caller
 * is told to sign in again.
 */
@Injectable()
export class ProjectCommitsService {
  private readonly logger = new Logger(ProjectCommitsService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly tokens: ProjectGithubTokenResolver,
  ) {}

  async listCommits(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    viewerLogin: string | null,
    query: ProjectCommitsQuery = {},
  ): Promise<ProjectCommitsResponse> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1),
      MAX_LIMIT,
    );
    const page = query.before ? decodeCommitCursor(query.before) : 1;
    const role = await this.projectsRepository.findAppRole(userId);

    const candidates = this.tokens.userFirst(
      project.repo_full_name,
      userId,
      oauthToken,
    );
    let signInExpired = false;
    for (const candidate of candidates) {
      const token = await candidate();
      if (!token) continue;
      try {
        return await this.read(
          token,
          project.repo_full_name,
          role,
          viewerLogin,
          query.branch?.trim() || null,
          limit,
          page,
        );
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        signInExpired = true;
      }
    }

    if (signInExpired) {
      throw new UnauthorizedException(SIGN_IN_AGAIN);
    }
    throw new UnauthorizedException(
      'No usable GitHub token found. Link the GitHub App installation or sign in again.',
    );
  }

  private async read(
    token: string,
    repoFullName: string,
    role: string,
    viewerLogin: string | null,
    requestedBranch: string | null,
    limit: number,
    page: number,
  ): Promise<ProjectCommitsResponse> {
    const all = await this.githubService.listBranches(token, repoFullName);
    const authors =
      role === 'member' && viewerLogin
        ? await this.githubService
            .listBranchHeadAuthors(token, repoFullName)
            .catch((error: unknown) => {
              this.logger.debug(
                `Branch author lookup failed; matching own branches by name only: ${String(error)}`,
              );
              return null;
            })
        : null;
    const visible = visibleBranchesFor(role, viewerLogin, all, authors);
    const names = this.orderBranches(visible);

    const branch = requestedBranch
      ? this.requireKnownBranch(requestedBranch, visible)
      : await this.defaultBranch(token, repoFullName, visible);
    if (!branch) {
      return { branch: '', branches: names, items: [], next: null };
    }

    const commits = await this.githubService.listCommits(token, repoFullName, {
      branch,
      perPage: limit,
      page,
    });
    return {
      branch,
      branches: names,
      items: commits.items.map((commit) => {
        const message = (commit.message.split(/\r?\n/, 1)[0] ?? '').trim();
        return {
          sha: commit.sha,
          shortSha: commit.sha.slice(0, 7),
          message,
          authorLogin: commit.authorLogin,
          authorName: commit.authorName,
          authoredAt: commit.authoredAt,
          url: commit.url,
          pullRequestNumber: pullRequestNumberFromMessage(message),
        };
      }),
      next: commits.hasNextPage ? encodeCommitCursor(page + 1) : null,
    };
  }

  private orderBranches(visible: GitHubBranchSummary[]): string[] {
    const pipeline: string[] = PIPELINE_BRANCHES.filter((name) =>
      visible.some((branch) => branch.name === name),
    );
    const rest = visible
      .map((branch) => branch.name)
      .filter((name) => !pipeline.includes(name))
      .sort((a, b) => a.localeCompare(b));
    return [...pipeline, ...rest].slice(0, MAX_BRANCHES_LISTED);
  }

  private requireKnownBranch(
    branch: string,
    visible: GitHubBranchSummary[],
  ): string {
    if (!visible.some((candidate) => candidate.name === branch)) {
      throw new BadRequestException(
        `Branch '${branch}' is not one of this repository's branches.`,
      );
    }
    return branch;
  }

  /** `dev` when it is there, otherwise the repository's default branch. */
  private async defaultBranch(
    token: string,
    repoFullName: string,
    visible: GitHubBranchSummary[],
  ): Promise<string | null> {
    if (visible.some((branch) => branch.name === 'dev')) {
      return 'dev';
    }
    const [owner, repo] = repoFullName.split('/');
    try {
      const repository = await this.githubService.getRepo(
        token,
        owner ?? '',
        repo ?? '',
      );
      const name = repository.defaultBranch?.trim();
      if (name && visible.some((branch) => branch.name === name)) return name;
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      this.logger.debug(
        `Could not read the default branch of ${repoFullName}: ${String(error)}`,
      );
    }
    return visible[0]?.name ?? null;
  }
}
