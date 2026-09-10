import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { ProjectWorkspaceService } from '../application/workspace/project-workspace.service';

/**
 * GET-only views of a project's repository: Code, Pull requests and Pipeline
 * runs.
 *
 * Split from ProjectsController rather than added to it because these are the
 * only routes in the product that read GitHub live on every request. Keeping
 * them together makes the polling contract legible in one file — and makes it
 * obvious when someone adds a route that breaks it.
 *
 * The contract, in request terms:
 *   GET runs                  — safe to poll
 *   GET runs/:runId/jobs      — on open only
 *   GET jobs/:jobId/logs      — on open only, never polled
 *   GET runs/:runId/failure-log — on open only, never polled
 */
@Controller('projects/:projectId/workspace')
@UseGuards(SessionAuthGuard)
export class ProjectWorkspaceController {
  constructor(private readonly workspaceService: ProjectWorkspaceService) {}

  @Get('branches')
  listBranches(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.workspaceService.listBranches(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
    );
  }

  /**
   * `path` empty lists the repository root. `ref` omitted resolves to the
   * default branch server-side, so a cold open needs one request, not two.
   */
  @Get('files')
  listFiles(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('path') path = '',
    @Query('ref') ref?: string,
  ) {
    return this.workspaceService.listFiles(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      path,
      ref?.trim() ? ref.trim() : null,
    );
  }

  @Get('runs')
  listRuns(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('branch') branch?: string,
  ) {
    return this.workspaceService.listWorkflowRuns(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      branch?.trim() ? branch.trim() : null,
    );
  }

  @Get('runs/:runId/jobs')
  listRunJobs(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.workspaceService.getRunJobs(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      this.requireNumericId(runId, 'run'),
    );
  }

  /**
   * The error output of the job that failed in this run.
   *
   * Distinct from `jobs/:jobId/logs`, which needs the caller to already know
   * which job to open. Here the caller has only a failed STAGE, and finding
   * the job is the server's work.
   */
  @Get('runs/:runId/failure-log')
  getRunFailureLog(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.workspaceService.getRunFailureLog(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      this.requireNumericId(runId, 'run'),
    );
  }

  @Get('jobs/:jobId/logs')
  getJobLog(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.workspaceService.getJobLog(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      this.requireNumericId(jobId, 'job'),
    );
  }

  @Get('pull-requests')
  listPullRequests(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('state') state?: string,
  ) {
    const allowed = ['open', 'closed', 'all'] as const;
    const normalized = allowed.find((value) => value === state) ?? 'all';

    return this.workspaceService.listPullRequests(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      normalized,
    );
  }

  @Get('pull-requests/:number/files')
  getPullRequestFiles(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('number') pullNumber: string,
  ) {
    return this.workspaceService.getPullRequestFiles(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      this.requireNumericId(pullNumber, 'pull request'),
    );
  }

  /**
   * One pull request, its checks, and whether the viewer may approve it.
   *
   * Exists so deciding about a pull request does not require leaving for
   * GitHub: the checks and the mergeable state are what the decision turns on,
   * and the list response carries neither.
   */
  @Get('pull-requests/:number')
  getPullRequestDetail(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('number') pullNumber: string,
  ) {
    return this.workspaceService.getPullRequestDetail(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      this.requireNumericId(pullNumber, 'pull request'),
      this.viewerLogin(req),
    );
  }

  /**
   * Merge a pull request from inside the product.
   *
   * A refusal is a 200 with `merged: false` and GitHub's own sentence, because
   * "at least 1 approving review is required" is an answer rather than a
   * failure of this endpoint.
   */
  @Post('pull-requests/:number/merge')
  mergePullRequest(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('number') pullNumber: string,
    @Body() body: { method?: 'merge' | 'squash' | 'rebase' },
  ) {
    const method = body?.method ?? 'merge';
    if (!['merge', 'squash', 'rebase'].includes(method)) {
      throw new BadRequestException(
        'Invalid merge method. Use merge, squash or rebase.',
      );
    }
    return this.workspaceService.mergePullRequest(
      projectId,
      this.requireUserId(req),
      this.oauthToken(req),
      this.requireNumericId(pullNumber, 'pull request'),
      method,
    );
  }

  private requireUserId(req: Request): string {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }

  private oauthToken(req: Request): string | null {
    return req.session.githubAccessToken ?? null;
  }

  /**
   * The viewer's GitHub login, for deciding whether they authored a pull
   * request. Read from the session because an installation token identifies
   * the app rather than the person holding it.
   */
  private viewerLogin(req: Request): string | null {
    return req.session.user?.login ?? null;
  }

  /**
   * GitHub's run and job identifiers are numbers, and they go straight into a
   * URL. Rejecting anything else here keeps a hand-typed path from reaching the
   * GitHub API as a malformed request we would then have to explain.
   */
  private requireNumericId(value: string, what: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`Invalid ${what} id`);
    }
    return parsed;
  }
}
