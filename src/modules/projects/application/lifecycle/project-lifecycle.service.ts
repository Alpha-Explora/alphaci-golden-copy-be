import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  GithubRepoDeleteError,
  GithubService,
  type GithubRepoDeleteErrorCode,
} from '#modules/pipelines/index.js';
import { AuditEventsService } from '#modules/platform-ops/index.js';
import {
  WorkspaceAccessService,
  type WorkspaceRole,
} from '#modules/identity-access/index.js';
import type { CreateProjectDto } from '../../dto/create-project.dto';
import type { DisconnectProjectDto } from '../../dto/disconnect-project.dto';
import type { SetupProjectDto } from '../../dto/setup-project.dto';
import { ProjectsRepository } from '../../projects.repository';
import type {
  CreateProjectResponse,
  DisconnectProjectResponse,
  SetupProjectResponse,
  SyncProjectsResponse,
} from '../../projects.service.types';

/**
 * Narrow compatibility port for the provisioning use cases that are still
 * implemented by ProjectsService. The lifecycle application slice does not
 * depend on that concrete class, so provisioning can be extracted later
 * without recreating a cross-context service cycle.
 */
export interface ProjectProvisioningPort {
  createProject(
    userId: string,
    userLogin: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse>;
  setupProject(
    userId: string,
    accessToken: string | null,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse>;
}

export const PROJECT_PROVISIONING_PORT = Symbol('ProjectProvisioningPort');

/**
 * Project lifecycle application use cases.
 *
 * Disconnect and repository-sync behavior is owned here. Provisioning remains
 * an explicit compatibility seam behind ProjectProvisioningPort; it is not a
 * second implementation or a concrete ProjectsService dependency.
 */
@Injectable()
export class ProjectLifecycleService {
  private readonly logger = new Logger(ProjectLifecycleService.name);

  constructor(
    @Inject(PROJECT_PROVISIONING_PORT)
    private readonly provisioningPort: ProjectProvisioningPort,
    private readonly projectsRepository: ProjectsRepository,
    private readonly githubService: GithubService,
    @Optional()
    private readonly workspaceAccessService?: WorkspaceAccessService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly notificationEventPublisher?: NotificationEventPublisher,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
  ) {}

  createProject(
    userId: string,
    userLogin: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    return this.provisioningPort.createProject(
      userId,
      userLogin,
      accessToken,
      dto,
    );
  }

  setupProject(
    userId: string,
    accessToken: string | null,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    return this.provisioningPort.setupProject(userId, accessToken, dto);
  }

  async disconnectProject(
    projectId: string,
    userId: string,
    options?: DisconnectProjectDto,
    githubAccessToken?: string | null,
  ): Promise<DisconnectProjectResponse> {
    const deleteGithubRepo = options?.deleteGithubRepo === true;
    // Use the same role set for the application fast-fail and SQL predicate.
    // The repository check remains the fail-closed enforcement point when
    // optional application wiring is absent.
    const destructiveRoles: WorkspaceRole[] = ['admin', 'delegated_lead'];

    try {
      await this.assertProjectMutationAccess(
        projectId,
        userId,
        deleteGithubRepo ? destructiveRoles : undefined,
      );
    } catch (error) {
      if (deleteGithubRepo) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: 'Insufficient workspace role for deleteGithubRepo=true (owner/admin required).',
          metadata: { reason: 'insufficient_role' },
        });
      }
      throw error;
    }

    let githubRepoDeleted = false;
    let githubRepoDeleteError:
      | { code: GithubRepoDeleteErrorCode; message: string }
      | undefined;

    if (deleteGithubRepo) {
      const project = await this.projectsRepository.findByIdAndUser(
        projectId,
        userId,
        destructiveRoles,
      );
      if (!project) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: `Project '${projectId}' was not found, does not belong to the current user, or the current workspace role does not permit deleting its GitHub repository (owner/admin required).`,
          metadata: { reason: 'not_found_or_insufficient_role' },
        });
        throw new NotFoundException(
          `Project '${projectId}' not found or does not belong to the current user.`,
        );
      }

      const repoFullName = project.repo_full_name;
      if (options?.confirmRepoName !== repoFullName) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: `confirmRepoName did not match this project's repository name (${repoFullName}). The GitHub repository was not deleted.`,
          metadata: { reason: 'confirmation_mismatch', repoFullName },
        });
        throw new BadRequestException(
          "confirmRepoName does not match this project's repository name. The GitHub repository was not deleted.",
        );
      }

      if (!githubAccessToken) {
        githubRepoDeleteError = {
          code: 'missing_scope',
          message:
            'No GitHub access token on this session — reconnect your GitHub account to grant repository-deletion permission.',
        };
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_missing_scope',
          title: 'GitHub repository deletion needs reconnect',
          body: `Could not delete ${repoFullName} on GitHub: no GitHub access token on this session.`,
          metadata: { repoFullName, code: 'missing_scope' },
        });
      } else {
        const [owner, repo] = repoFullName.split('/');
        if (!owner || !repo) {
          githubRepoDeleteError = {
            code: 'other',
            message: `Could not derive an owner/repo from '${repoFullName}'.`,
          };
          await this.recordProductEvent({
            userId,
            projectId,
            eventCode: 'project_github_repo_delete_failed',
            title: 'GitHub repository deletion failed',
            body: `Could not derive an owner/repo from '${repoFullName}'.`,
            metadata: { repoFullName, code: 'other' },
          });
        } else {
          try {
            await this.githubService.deleteRepoForUser(
              githubAccessToken,
              owner,
              repo,
            );
            githubRepoDeleted = true;
            await this.recordProductEvent({
              userId,
              projectId,
              eventCode: 'project_github_repo_deleted',
              title: 'GitHub repository deleted',
              body: `${repoFullName} was deleted from GitHub.`,
              metadata: { repoFullName },
            });
          } catch (error) {
            const deleteError =
              error instanceof GithubRepoDeleteError
                ? { code: error.code, message: error.message }
                : { code: 'other' as const, message: (error as Error).message };
            githubRepoDeleteError = deleteError;
            await this.recordProductEvent({
              userId,
              projectId,
              eventCode:
                deleteError.code === 'missing_scope'
                  ? 'project_github_repo_delete_missing_scope'
                  : 'project_github_repo_delete_failed',
              title: 'GitHub repository deletion failed',
              body: `Could not delete ${repoFullName} on GitHub: ${deleteError.message}`,
              metadata: { repoFullName, code: deleteError.code },
            });
          }
        }
      }
    }

    const deleted = await this.projectsRepository.deleteByIdAndUser(
      projectId,
      userId,
      deleteGithubRepo ? destructiveRoles : undefined,
    );
    if (!deleted) {
      throw new NotFoundException(
        `Project '${projectId}' not found or does not belong to the current user.`,
      );
    }

    return {
      ok: true,
      githubRepoDeleted,
      ...(githubRepoDeleteError ? { githubRepoDeleteError } : {}),
    };
  }

  /** Checks tracked projects without treating inconclusive GitHub failures as missing repos. */
  async syncProjects(
    userId: string,
    accessToken: string,
  ): Promise<SyncProjectsResponse> {
    const rows = await this.projectsRepository.listByUser(userId, 100);
    if (rows.length === 0) {
      await this.recordProductEvent({
        userId,
        projectId: null,
        eventCode: 'project_sync_completed',
        title: 'Project sync completed',
        body: 'Project repository sync found no tracked projects.',
        metadata: { orphaned: 0, reachable: 0, total: 0 },
      });
      return { orphaned: 0, reachable: 0, total: 0 };
    }

    const orphanedIds: string[] = [];
    const reachableIds: string[] = [];
    const CONCURRENCY = 10;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          try {
            const exists = await this.githubService.repoExists(
              accessToken,
              row.repo_full_name,
            );
            if (exists) {
              reachableIds.push(row.id);
            } else {
              orphanedIds.push(row.id);
            }
          } catch (error) {
            this.logger.warn(
              `Sync: GitHub check failed for ${row.repo_full_name}: ${String(error)}`,
            );
          }
        }),
      );
    }

    const [orphanedCount, reachableCount] = await Promise.all([
      this.projectsRepository.markOrphaned(orphanedIds, userId),
      this.projectsRepository.markReachable(reachableIds, userId),
    ]);

    await this.recordProductEvent({
      userId,
      projectId: null,
      eventCode: 'project_sync_completed',
      title: 'Project sync completed',
      body: `Project repository sync checked ${rows.length} tracked project${rows.length === 1 ? '' : 's'}.`,
      metadata: {
        orphaned: orphanedCount,
        reachable: reachableCount,
        total: rows.length,
      },
    });

    return {
      orphaned: orphanedCount,
      reachable: reachableCount,
      total: rows.length,
    };
  }

  private async assertProjectMutationAccess(
    projectId: string,
    userId: string,
    roles: WorkspaceRole[] = ['admin', 'delegated_lead', 'member'],
  ): Promise<void> {
    await this.workspaceAccessService?.assertProjectRole(
      projectId,
      userId,
      roles,
    );
  }

  private async recordProductEvent(input: {
    userId: string;
    projectId: string | null;
    eventCode: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await Promise.all([
      this.auditEventPublisher?.recordProjectEvent({
        actorUserId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        message: input.body,
        metadata: input.metadata,
      }) ??
        this.auditEventsService?.recordProjectEvent({
          actorUserId: input.userId,
          projectId: input.projectId,
          eventCode: input.eventCode,
          message: input.body,
          metadata: input.metadata,
        }),
      this.notificationEventPublisher?.record({
        userId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        title: input.title,
        body: input.body,
      }),
    ]).then(() => undefined);
  }
}
