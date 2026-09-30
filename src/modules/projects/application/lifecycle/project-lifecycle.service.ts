import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  DEPLOYMENT_PROVIDER_RESOURCES_TEARDOWN,
  type DeploymentProviderResourcesTeardown,
} from '#kernel/ports/deployment-runtime.port';
import {
  GITHUB_PROJECT_PORT,
  GithubRepoDeleteError,
  type GithubProjectPort,
  type GithubRepoDeleteErrorCode,
} from '#kernel/ports/github.port';
import { canManageProjectLifecycle } from '#kernel/rules/persona-access.rules';
import type { CreateProjectDto } from '../../api/dto/create-project.dto';
import type { DisconnectProjectDto } from '../../api/dto/disconnect-project.dto';
import type { SetupProjectDto } from '../../api/dto/setup-project.dto';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../../infrastructure/projects.repository';
import type {
  CreateProjectResponse,
  DisconnectProjectResponse,
  SetupProjectResponse,
  SyncProjectsResponse,
} from './projects.service.types';
import { SonarCloudSetupService } from './sonar-cloud-setup.service';

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
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    @Optional()
    private readonly auditEventsService?: AuditEventPublisher,
    @Optional()
    private readonly notificationEventPublisher?: NotificationEventPublisher,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
    @Optional()
    @Inject(DEPLOYMENT_PROVIDER_RESOURCES_TEARDOWN)
    private readonly providerResourcesTeardown?: DeploymentProviderResourcesTeardown,
    @Optional()
    private readonly sonarCloud?: SonarCloudSetupService,
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

  /**
   * Disconnect a project — every variant, including the plain, non-
   * destructive default.
   *
   * app_role is the sole authority here now (see persona-access.rules.ts):
   * admin/lead only, for every variant. This replaces the previous stored
   * per-workspace-role check (WorkspaceAccessPort.assertProjectRole), which
   * (a) let a stored 'member' role disconnect non-destructively — a global
   * app_role of 'member' or 'qa' no longer can, regardless of their stored
   * workspace role — and (b) silently PASSED when the caller had no
   * membership row at all, rather than refusing. Visibility is checked
   * first and separately, with the codebase's usual role-aware predicate
   * (global admin / owner / any active workspace member / assigned
   * repository) — a project this user cannot see answers 404, never
   * confirming it exists; a visible project the caller's persona may not
   * touch answers 403. Both fail closed: no visible row and no resolvable
   * role are treated as "not allowed", never as "allowed by default".
   *
   * The resolved project row is reused for everything below rather than
   * re-queried with a stored-role-restricted predicate — that predicate
   * encoded a DIFFERENT authority (orgs.workspace_members.role) than the one
   * now guarding this method, and re-deriving it here would reintroduce
   * exactly the app_role/workspace_role mismatch this replaces (see
   * qa-access.service.ts's own doc comment on the same distinction). The
   * destructive opt-ins (deleteGithubRepo + confirmRepoName,
   * deleteProviderResources, deleteSonarProject) are unchanged.
   */
  async disconnectProject(
    projectId: string,
    userId: string,
    options?: DisconnectProjectDto,
    githubAccessToken?: string | null,
  ): Promise<DisconnectProjectResponse> {
    const deleteGithubRepo = options?.deleteGithubRepo === true;
    const deleteProviderResources = options?.deleteProviderResources === true;
    const deleteSonarProject = options?.deleteSonarProject === true;

    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      await this.maybeRejectGithubDelete(deleteGithubRepo, userId, projectId);
      throw new NotFoundException(
        `Project '${projectId}' not found or does not belong to the current user.`,
      );
    }

    const role = await this.projectsRepository.findAppRole(userId);
    if (!canManageProjectLifecycle(role)) {
      await this.maybeRejectGithubDelete(deleteGithubRepo, userId, projectId);
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PROJECT_ROLE_FORBIDDEN',
        message: 'Only a lead or admin may disconnect this project.',
      });
    }

    const { githubRepoDeleted, githubRepoDeleteError } =
      await this.deleteGithubRepoIfRequested(
        deleteGithubRepo,
        projectId,
        userId,
        options,
        githubAccessToken,
        project,
      );

    /*
     * GitHub refused, so the project stays.
     *
     * This used to disconnect locally anyway and tuck the refusal into the
     * response, which the page never read. Two deletions went that way: the
     * repositories are still on GitHub, the projects were gone from ALPHACI,
     * and with them the only screen that could have retried. The user had
     * asked for both to go and got half, told neither.
     *
     * Keeping the project keeps the retry. Someone who only wants to
     * disconnect - including when the repository was already deleted by hand
     * - unticks "also delete on GitHub" and the local delete goes through.
     *
     * 409 rather than a 200 carrying an error: nothing was changed, and a
     * success status is what let the old failure pass as a success.
     *
     * GitHub goes first, before Render/Vercel/SonarCloud: it is the half most
     * often refused, and it is where confirmRepoName is checked, so a refusal
     * or a mistyped name leaves every other resource untouched.
     */
    if (githubRepoDeleteError) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: githubRepoDeleteError.code,
        message: `${githubRepoDeleteError.message} The project was kept so you can try again.`,
      });
    }

    const alreadyDone = githubRepoDeleted
      ? ' The GitHub repository was already deleted - untick "also delete on GitHub" before trying again.'
      : '';

    const providerResourcesDeleted = deleteProviderResources
      ? await this.deleteProviderResourcesOrThrow(
          projectId,
          userId,
          alreadyDone,
        )
      : undefined;

    const sonarProjectDeleted = deleteSonarProject
      ? await this.deleteSonarProjectOrThrow(
          projectId,
          userId,
          project.repo_full_name,
          alreadyDone,
        )
      : undefined;

    const deleted = await this.projectsRepository.deleteByIdAndUser(
      projectId,
      userId,
    );
    if (!deleted) {
      throw new NotFoundException(
        `Project '${projectId}' not found or does not belong to the current user.`,
      );
    }

    return {
      ok: true,
      githubRepoDeleted,
      ...(providerResourcesDeleted !== undefined
        ? { providerResourcesDeleted }
        : {}),
      ...(sonarProjectDeleted !== undefined ? { sonarProjectDeleted } : {}),
    };
  }

  /** Deletes the live Render/Vercel resources; 409 if any is left. */
  private async deleteProviderResourcesOrThrow(
    projectId: string,
    userId: string,
    alreadyDone: string,
  ): Promise<number> {
    if (!this.providerResourcesTeardown) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'provider_delete_failed',
        message: `Deployment deletion is not available on this server, so nothing was deleted from Render or Vercel.${alreadyDone} Untick "also delete the deployments" to disconnect without them. The project was kept.`,
      });
    }

    const result =
      await this.providerResourcesTeardown.deleteProviderResourcesForProject(
        projectId,
        userId,
      );
    if (result.failed.length > 0) {
      const failures = result.failed
        .map(
          (failure) =>
            `${failure.provider} ${failure.providerProjectName}: ${failure.message}`,
        )
        .join('; ');
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'provider_delete_failed',
        message: `Some deployments could not be deleted (${failures}).${alreadyDone} The project was kept so you can try again.`,
      });
    }
    return result.deleted.length;
  }

  /** Deletes the SonarCloud project; true if one existed. 409 on failure. */
  private async deleteSonarProjectOrThrow(
    projectId: string,
    userId: string,
    repoFullName: string,
    alreadyDone: string,
  ): Promise<boolean> {
    const [owner, repo] = repoFullName.split('/');
    const result =
      owner && repo && this.sonarCloud
        ? await this.sonarCloud.deleteProject(owner, repo)
        : {
            status: 'failed' as const,
            sonarProjectKey: '',
            message: this.sonarCloud
              ? `Could not derive an owner/repo from '${repoFullName}'.`
              : 'SonarCloud deletion is not available on this server.',
          };

    await this.recordProductEvent({
      userId,
      projectId,
      eventCode:
        result.status === 'failed'
          ? 'project_sonar_project_delete_failed'
          : 'project_sonar_project_deleted',
      title:
        result.status === 'failed'
          ? 'SonarCloud project deletion failed'
          : 'SonarCloud project deleted',
      body:
        result.status === 'failed'
          ? `Could not delete SonarCloud project ${result.sonarProjectKey}: ${result.message}`
          : result.status === 'deleted'
            ? `SonarCloud project ${result.sonarProjectKey} was deleted.`
            : `No SonarCloud project ${result.sonarProjectKey} existed in the managed organization.`,
      metadata: { repoFullName, ...result },
    });

    if (result.status === 'failed') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'sonar_delete_failed',
        message: `The SonarCloud project could not be deleted: ${result.message}${alreadyDone} Untick "also delete the SonarCloud project" to disconnect without it. The project was kept.`,
      });
    }
    return result.status === 'deleted';
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

    // The caller's OAuth token says nothing about what OTHER people's
    // projects look like: it may simply not see a private repository. So a
    // row is only ever checked, and marked, when the caller owns it or holds
    // a lead/admin app_role (allow-list). Never inferred from workspace
    // membership. An unresolved role falls back to 'member' (owned only).
    const role =
      (await this.projectsRepository.findAppRole(userId)) ?? 'member';
    const mayManageOthers = canManageProjectLifecycle(role);
    const eligible = rows.filter(
      (row) => row.user_id === userId || mayManageOthers,
    );

    const orphanedIds: string[] = [];
    const reachableIds: string[] = [];
    const CONCURRENCY = 10;

    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
      const batch = eligible.slice(i, i + CONCURRENCY);
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

  private async maybeRejectGithubDelete(
    deleteGithubRepo: boolean,
    userId: string,
    projectId: string,
  ): Promise<void> {
    if (!deleteGithubRepo) {
      return;
    }

    await this.recordProductEvent({
      userId,
      projectId,
      eventCode: 'project_github_repo_delete_rejected',
      title: 'GitHub repository deletion rejected',
      body: 'The project is not visible to this user, or their global persona is not admin/lead (required for deleteGithubRepo=true).',
      metadata: { reason: 'insufficient_role' },
    });
  }

  private async deleteGithubRepoIfRequested(
    deleteGithubRepo: boolean,
    projectId: string,
    userId: string,
    options: DisconnectProjectDto | undefined,
    githubAccessToken: string | null | undefined,
    project: ProvisionedProjectRow,
  ): Promise<{
    githubRepoDeleted: boolean;
    githubRepoDeleteError?: {
      code: GithubRepoDeleteErrorCode;
      message: string;
    };
  }> {
    if (!deleteGithubRepo) {
      return { githubRepoDeleted: false };
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

    return this.deleteConfirmedGithubRepo(
      projectId,
      userId,
      repoFullName,
      githubAccessToken,
    );
  }

  private async deleteConfirmedGithubRepo(
    projectId: string,
    userId: string,
    repoFullName: string,
    githubAccessToken: string | null | undefined,
  ): Promise<{
    githubRepoDeleted: boolean;
    githubRepoDeleteError?: {
      code: GithubRepoDeleteErrorCode;
      message: string;
    };
  }> {
    if (!githubAccessToken) {
      const githubRepoDeleteError = {
        code: 'token_rejected' as const,
        message:
          'This session has no GitHub access token, so the repository was not deleted. Sign out and sign back in, then try again.',
      };
      await this.recordProductEvent({
        userId,
        projectId,
        eventCode: 'project_github_repo_delete_failed',
        title: 'GitHub repository deletion needs you to sign in again',
        body: `Could not delete ${repoFullName} on GitHub: no GitHub access token on this session.`,
        metadata: { repoFullName, code: 'token_rejected' },
      });
      return { githubRepoDeleted: false, githubRepoDeleteError };
    }

    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      const githubRepoDeleteError = {
        code: 'other' as const,
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
      return { githubRepoDeleted: false, githubRepoDeleteError };
    }

    try {
      await this.githubService.deleteRepoForUser(
        githubAccessToken,
        owner,
        repo,
      );
      await this.recordProductEvent({
        userId,
        projectId,
        eventCode: 'project_github_repo_deleted',
        title: 'GitHub repository deleted',
        body: `${repoFullName} was deleted from GitHub.`,
        metadata: { repoFullName },
      });
      return { githubRepoDeleted: true };
    } catch (error) {
      const deleteError =
        error instanceof GithubRepoDeleteError
          ? { code: error.code, message: error.message }
          : { code: 'other' as const, message: (error as Error).message };
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
      return { githubRepoDeleted: false, githubRepoDeleteError: deleteError };
    }
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
