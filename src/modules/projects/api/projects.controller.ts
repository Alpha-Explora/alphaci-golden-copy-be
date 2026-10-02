import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  Optional,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import {
  DEPLOYMENT_DRIFT_QUERY,
  DEPLOYMENT_HISTORY_QUERY,
  type DeploymentDriftQuery,
  type DeploymentHistoryQuery,
  type ProjectDriftRepairAction,
} from '#kernel/ports/deployment-runtime.port';
import { CreateProjectDto } from './dto/create-project.dto';
import { SetupProjectDto } from './dto/setup-project.dto';
import { DisconnectProjectDto } from './dto/disconnect-project.dto';
import { ProjectCiRunsService } from '../application/ci-runs/project-ci-runs.service';
import { ProjectPreviewsService } from '../application/dashboard/project-previews.query-service';
import { ProjectDriftRepairService } from '../application/drift/project-drift-repair.handler';
import { ProjectsService } from '../application/lifecycle/projects.service';
import type { ProjectAuditEventsOptions } from '../application/lifecycle/projects.service.types';
import { ProjectDashboardService } from '../application/dashboard/project-dashboard.service';
import { ProjectDriftRepairApplicationService } from '../application/drift/project-drift-repair.service';
import { ProjectLifecycleService } from '../application/lifecycle/project-lifecycle.service';
import { ProjectPreviewsApplicationService } from '../application/dashboard/project-previews.service';
import { ProjectWorkflowsService } from '../application/workflows/project-workflows.service';

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectCiRunsService: ProjectCiRunsService,
    @Inject(DEPLOYMENT_HISTORY_QUERY)
    private readonly deploymentHistoryQuery: DeploymentHistoryQuery,
    private readonly projectPreviewsService: ProjectPreviewsService,
    @Inject(DEPLOYMENT_DRIFT_QUERY)
    private readonly deploymentDriftQuery: DeploymentDriftQuery,
    private readonly projectDriftRepairService: ProjectDriftRepairService,
    // Optional during the compatibility window: older unit consumers can
    // still provide ProjectsService directly while production wiring uses the
    // focused application services below.
    @Optional()
    private readonly projectLifecycleService?: ProjectLifecycleService,
    @Optional()
    private readonly projectDashboardService?: ProjectDashboardService,
    @Optional()
    private readonly projectWorkflowsService?: ProjectWorkflowsService,
    @Optional()
    private readonly projectPreviewsApplicationService?: ProjectPreviewsApplicationService,
    @Optional()
    private readonly projectDriftRepairApplicationService?: ProjectDriftRepairApplicationService,
  ) {}

  /**
   * POST /api/v1/projects
   * Creates a new GitHub repository, sets up branch structure + protection,
   * generates a workflow YAML from the chosen template, and pushes it.
   * Requires an active subscription.
   */
  @Post()
  @UseGuards(SessionAuthGuard, SubscriptionGuard)
  async createProject(@Req() req: Request, @Body() body: CreateProjectDto) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const userLogin = req.session.user?.login;
    if (!userLogin) {
      throw new UnauthorizedException(
        'GitHub login not found in session. Re-authenticate.',
      );
    }

    const accessToken = req.session.githubAccessToken ?? null;
    return (
      this.projectLifecycleService?.createProject(
        userId,
        userLogin,
        accessToken,
        body,
      ) ??
      this.projectsService.createProject(userId, userLogin, accessToken, body)
    );
  }

  /**
   * POST /api/v1/projects/setup
   * Generates a workflow YAML and pushes it to an existing GitHub repository.
   * Requires an active subscription.
   */
  @Post('setup')
  @UseGuards(SessionAuthGuard, SubscriptionGuard)
  async setupProject(@Req() req: Request, @Body() body: SetupProjectDto) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return (
      this.projectLifecycleService?.setupProject(
        userId,
        req.session.githubAccessToken ?? null,
        body,
      ) ??
      this.projectsService.setupProject(
        userId,
        req.session.githubAccessToken ?? null,
        body,
      )
    );
  }

  /**
   * GET /api/v1/projects
   * Returns all provisioned projects for the authenticated user.
   */
  @Get()
  @UseGuards(SessionAuthGuard)
  async listProjects(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const parsedLimit = Number.parseInt(limit ?? '25', 10);
    const safeLimit = Number.isFinite(parsedLimit) ? parsedLimit : 25;

    return (
      this.projectDashboardService?.listProjects(
        userId,
        safeLimit,
        workspaceId?.trim() || null,
      ) ??
      this.projectsService.listProjects(
        userId,
        safeLimit,
        workspaceId?.trim() || null,
      )
    );
  }

  /**
   * GET /api/v1/projects/:id/overview
   * Returns the read-only project control center state from stored ALPHACI data.
   */
  @Get(':id/overview')
  @UseGuards(SessionAuthGuard)
  async getProjectOverview(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    return (
      this.projectDashboardService?.getProjectOverview(id, userId) ??
      this.projectsService.getProjectOverview(id, userId)
    );
  }

  /**
   * POST /api/v1/projects/:id/sync
   * Writes a local dashboard snapshot from ALPHACI's stored project state.
   * This endpoint intentionally does not require a GitHub OAuth token.
   */
  @Post(':id/sync')
  @UseGuards(SessionAuthGuard)
  async syncProjectSnapshot(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    return (
      this.projectDashboardService?.syncProjectSnapshot(id, userId) ??
      this.projectsService.syncProjectSnapshot(id, userId)
    );
  }

  /**
   * GET /api/v1/projects/:id/workflow-settings
   * Returns normalized workflow settings for local preview.
   */
  @Get(':id/workflow-settings')
  @UseGuards(SessionAuthGuard)
  async getWorkflowSettings(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    return (
      this.projectWorkflowsService?.getWorkflowSettings(id, userId) ??
      this.projectsService.getWorkflowSettings(id, userId)
    );
  }

  /**
   * POST /api/v1/projects/:id/workflow-settings/preview
   * Generates local workflow YAML preview files without creating branches,
   * commits, or pull requests.
   */
  @Post(':id/workflow-settings/preview')
  @UseGuards(SessionAuthGuard)
  async previewWorkflowSettings(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    return (
      this.projectWorkflowsService?.previewWorkflowSettings(id, userId, body) ??
      this.projectsService.previewWorkflowSettings(id, userId, body)
    );
  }

  /**
   * POST /api/v1/projects/:id/workflow-settings/pr
   * Creates a GitHub pull request containing the generated staged workflow
   * files. Direct apply is intentionally not supported.
   */
  @Post(':id/workflow-settings/pr')
  @UseGuards(SessionAuthGuard)
  async createWorkflowUpdatePullRequest(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    return (
      this.projectWorkflowsService?.createWorkflowUpdatePullRequest(
        id,
        userId,
        req.session.githubAccessToken ?? null,
        body,
      ) ??
      this.projectsService.createWorkflowUpdatePullRequest(
        id,
        userId,
        req.session.githubAccessToken ?? null,
        body,
      )
    );
  }

  @Get(':id/ci-runs')
  @UseGuards(SessionAuthGuard)
  async listCiRuns(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    return this.projectCiRunsService.listRuns(id, userId);
  }

  @Get(':id/ci-runs/:runId')
  @UseGuards(SessionAuthGuard)
  async getCiRun(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('runId') runId: string,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.projectCiRunsService.getRun(id, runId, userId);
  }

  @Post(':id/ci-runs/:runId/rerun')
  @UseGuards(SessionAuthGuard)
  async rerunCiRun(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('runId') runId: string,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.projectCiRunsService.rerun(id, runId, userId);
  }

  @Get(':id/deployments')
  @UseGuards(SessionAuthGuard)
  async listDeployments(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    const project = await (this.projectDashboardService?.getProjectReference(
      id,
      userId,
    ) ?? this.projectsService.getProjectReference(id, userId));
    return this.deploymentHistoryQuery.listDeployments(project);
  }

  @Get(':id/previews')
  @UseGuards(SessionAuthGuard)
  async listPreviews(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    const project = await (this.projectDashboardService?.getProjectReference(
      id,
      userId,
    ) ?? this.projectsService.getProjectReference(id, userId));
    return (
      this.projectPreviewsApplicationService?.listPreviews(project) ??
      this.projectPreviewsService.listPreviews(project)
    );
  }

  @Get(':id/drift')
  @UseGuards(SessionAuthGuard)
  async listDriftFindings(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    const project = await (this.projectDashboardService?.getProjectReference(
      id,
      userId,
    ) ?? this.projectsService.getProjectReference(id, userId));
    return this.deploymentDriftQuery.listFindings(project);
  }

  @Post(':id/drift/run')
  @UseGuards(SessionAuthGuard)
  async runDriftDetection(@Req() req: Request, @Param('id') id: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    const project = await (this.projectDashboardService?.getProjectReference(
      id,
      userId,
    ) ?? this.projectsService.getProjectReference(id, userId));
    return this.deploymentDriftQuery.runDetection(project, {
      githubAccessToken: req.session.githubAccessToken ?? null,
    });
  }

  @Post(':id/drift/:findingId/repair')
  @UseGuards(SessionAuthGuard)
  async repairDriftFinding(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('findingId') findingId: string,
    @Body() body: { action?: ProjectDriftRepairAction },
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id || !findingId) {
      throw new NotFoundException('Project ID and finding ID are required');
    }

    return (
      this.projectDriftRepairApplicationService?.repair(
        id,
        findingId,
        userId,
        body.action ?? 'mark_ignored',
        req.session.githubAccessToken ?? null,
      ) ??
      this.projectDriftRepairService.repair(
        id,
        findingId,
        userId,
        body.action ?? 'mark_ignored',
        req.session.githubAccessToken ?? null,
      )
    );
  }

  @Get(':id/audit')
  @UseGuards(SessionAuthGuard)
  async listProjectAuditEvents(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    const options = parseAuditPaging(limit, before);
    return (
      this.projectDashboardService?.listProjectAuditEvents(
        id,
        userId,
        options,
      ) ?? this.projectsService.listProjectAuditEvents(id, userId, options)
    );
  }

  /**
   * DELETE /api/v1/projects/:id
   * Removes a project from ALPHACI tracking. By default the GitHub
   * repository, workflow YAML files, and GitHub Secrets are NOT touched —
   * this only removes the ALPHACI database record and cascades to
   * ci.project_ci_tokens.
   *
   * Opt-in: pass `{ deleteGithubRepo: true, confirmRepoName: <repo_full_name> }`
   * to also delete the GitHub repository. confirmRepoName must exactly match
   * the project's repo_full_name (e.g. "my-org/my-repo") — this is
   * re-validated server-side and requires the owner/admin workspace role.
   * If GitHub refuses the deletion, nothing changes: the project is kept and
   * the request fails with 409 and the reason, so the user can retry, or untick
   * the GitHub option to disconnect on its own.
   *
   * Further opt-ins (same owner/admin role): `deleteProviderResources` deletes
   * the live Render/Vercel resources behind the project's deployment targets,
   * and `deleteSonarProject` deletes its SonarCloud project. They run after
   * the GitHub half and follow the same rule: a failure keeps the project and
   * fails the request with 409.
   *
   * Throttled tighter than the app default (60/60s) and auth (10/60s):
   * this is a user-triggered, potentially irreversible deletion.
   */
  @Delete(':id')
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async disconnectProject(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body?: DisconnectProjectDto,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!id) {
      throw new NotFoundException('Project ID is required');
    }

    const accessToken = req.session.githubAccessToken ?? null;
    return (
      this.projectLifecycleService?.disconnectProject(
        id,
        userId,
        body,
        accessToken,
      ) ?? this.projectsService.disconnectProject(id, userId, body, accessToken)
    );
  }

  /**
   * POST /api/v1/projects/sync
   * Checks each provisioned project against the GitHub API to verify the
   * repository still exists. Missing repos are marked 'orphaned'; repos that
   * have reappeared are restored to 'provisioned'. Requires a GitHub token.
   */
  @Post('sync')
  @UseGuards(SessionAuthGuard)
  async syncProjects(@Req() req: Request) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const accessToken = req.session.githubAccessToken;
    if (!accessToken) {
      throw new UnauthorizedException(
        'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      );
    }

    return (
      this.projectLifecycleService?.syncProjects(userId, accessToken) ??
      this.projectsService.syncProjects(userId, accessToken)
    );
  }
}

const AUDIT_MAX_LIMIT = 100;
const AUDIT_CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** `?limit` (1-100) and `?before=<ISO createdAt>` for the Audit tab. */
function parseAuditPaging(
  limit: string | undefined,
  before: string | undefined,
): ProjectAuditEventsOptions {
  const options: ProjectAuditEventsOptions = {};
  if (limit !== undefined && limit !== '') {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    options.limit = Math.min(parsed, AUDIT_MAX_LIMIT);
  }
  if (before !== undefined && before !== '') {
    if (
      !AUDIT_CURSOR_PATTERN.test(before) ||
      Number.isNaN(Date.parse(before))
    ) {
      throw new BadRequestException('before must be an ISO-8601 timestamp');
    }
    options.before = before;
  }
  return options;
}
