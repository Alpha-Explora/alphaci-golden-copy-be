import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';

import { PROTECTED_BRANCHES } from '#kernel/config/pipeline-branches';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubBranchProtectionStatus,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectGithubTokenResolver } from '../github-activity/project-github-token.resolver';

export interface BranchProtectionBranchResult {
  name: string;
  status: GithubBranchProtectionStatus;
  error?: string;
}

export interface RepositoryProtectionResult {
  repoFullName: string;
  branches: BranchProtectionBranchResult[];
}

export interface BulkBranchProtectionResponse {
  results: RepositoryProtectionResult[];
  totals: Record<GithubBranchProtectionStatus, number>;
}

/** Repositories processed at once during the bulk run. */
const BULK_CONCURRENCY = 4;

/**
 * Applies the pull-request-only rule (dev, uat, main) to repositories that
 * already exist: the admin retrofit for everything provisioned before the rule.
 *
 * Admin only (allow-list on the global app_role, so an unresolved role is
 * refused). Idempotent: a branch that already satisfies the rule reports
 * `unchanged` and GitHub is not written to. Uses the installation token (the
 * App needs Administration: write); when only the caller's own token is
 * available it is used, and a 403/404 from GitHub is reported per branch as
 * missing admin permission.
 *
 * No required status checks are seeded here: an older repository may not have
 * the env-guard workflow, and a required check that never reports blocks every
 * merge. Checks the branch already requires are kept.
 */
@Injectable()
export class ProjectBranchProtectionService {
  private readonly logger = new Logger(ProjectBranchProtectionService.name);

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly tokens: ProjectGithubTokenResolver,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
  ) {}

  async applyToProject(
    projectId: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<RepositoryProtectionResult> {
    // Visibility first (404 without confirming the project exists), then role.
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    await this.assertAdmin(userId);

    const token = await this.tokens.installationFirst(
      project.repo_full_name,
      userId,
      oauthToken,
    );
    if (!token) {
      throw new UnauthorizedException(
        'No usable GitHub token found. Link the GitHub App installation or sign in again.',
      );
    }
    const result = await this.protectRepository(token, project.repo_full_name);
    await this.recordEvent(userId, project, result);
    return result;
  }

  async applyToAll(
    userId: string,
    oauthToken: string | null,
  ): Promise<BulkBranchProtectionResponse> {
    await this.assertAdmin(userId);

    const rows = await this.projectsRepository.listVisibleProvisioned(userId);
    // A packed microservices repository has one row per slot; protect it once.
    const seen = new Set<string>();
    const targets = rows.filter((row) => {
      const key = row.repo_full_name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const results: RepositoryProtectionResult[] = [];
    for (let i = 0; i < targets.length; i += BULK_CONCURRENCY) {
      const chunk = targets.slice(i, i + BULK_CONCURRENCY);
      const done = await Promise.all(
        chunk.map(async (row) => {
          const token = await this.tokens.installationFirst(
            row.repo_full_name,
            userId,
            oauthToken,
          );
          const result: RepositoryProtectionResult = token
            ? await this.protectRepository(token, row.repo_full_name)
            : {
                repoFullName: row.repo_full_name,
                branches: PROTECTED_BRANCHES.map((name) => ({
                  name,
                  status: 'failed' as const,
                  error: 'No usable GitHub token for this repository',
                })),
              };
          await this.recordEvent(userId, row, result);
          return result;
        }),
      );
      results.push(...done);
    }

    const totals: Record<GithubBranchProtectionStatus, number> = {
      applied: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
    };
    for (const result of results) {
      for (const branch of result.branches) totals[branch.status] += 1;
    }
    return { results, totals };
  }

  private async protectRepository(
    token: string,
    repoFullName: string,
  ): Promise<RepositoryProtectionResult> {
    const [owner = '', repo = ''] = repoFullName.split('/');
    const branches: BranchProtectionBranchResult[] = [];
    for (const name of PROTECTED_BRANCHES) {
      try {
        const outcome = await this.githubService.ensurePullRequestProtection(
          token,
          owner,
          repo,
          name,
        );
        branches.push({ name, ...outcome });
      } catch (error) {
        branches.push({
          name,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { repoFullName, branches };
  }

  private async assertAdmin(userId: string): Promise<void> {
    const role = await this.projectsRepository.findAppRole(userId);
    if (role !== 'admin') {
      throw new ForbiddenException(
        'Only an admin can change branch protection.',
      );
    }
  }

  private async recordEvent(
    userId: string,
    project: { id: string; workspace_id?: string | null },
    result: RepositoryProtectionResult,
  ): Promise<void> {
    const failed = result.branches.filter((b) => b.status === 'failed');
    const changed = result.branches.filter((b) => b.status === 'applied');
    if (failed.length === 0 && changed.length === 0) {
      return; // Nothing happened worth an audit row.
    }
    if (failed.length > 0) {
      this.logger.warn(
        `Branch protection failed on ${result.repoFullName}: ${failed
          .map((b) => `${b.name} (${b.error ?? 'unknown'})`)
          .join('; ')}`,
      );
    }
    await this.auditEventPublisher?.recordProjectEvent({
      actorUserId: userId,
      workspaceId: project.workspace_id ?? null,
      projectId: project.id,
      eventCode:
        failed.length > 0
          ? 'project_branch_protection_failed'
          : 'project_branch_protection_applied',
      message:
        failed.length > 0
          ? `Branch protection could not be applied to ${failed.map((b) => b.name).join(', ')}`
          : `Pull requests are now required on ${changed.map((b) => b.name).join(', ')}`,
      metadata: {
        repoFullName: result.repoFullName,
        branches: result.branches,
      },
    });
  }
}
