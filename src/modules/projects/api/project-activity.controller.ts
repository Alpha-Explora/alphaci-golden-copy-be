import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { ProjectBranchProtectionService } from '../application/branch-protection/project-branch-protection.service';
import { ProjectCommitsService } from '../application/github-activity/project-commits.service';
import { ProjectGithubActivityService } from '../application/github-activity/project-github-activity.service';

/**
 * What a repository's GitHub looks like from inside the product, and the
 * admin controls over it: the commit history, the GitHub activity feeding the
 * Audit trail, and pull-request-only branch protection.
 *
 * Split from ProjectsController for the reason ProjectWorkspaceController is:
 * these routes read or write GitHub live, and keeping them together keeps that
 * visible. Every route is session-authenticated; project visibility (404) and
 * the admin allow-list (403) are decided in the services.
 */
@Controller()
@UseGuards(SessionAuthGuard)
export class ProjectActivityController {
  constructor(
    private readonly commitsService: ProjectCommitsService,
    private readonly activityService: ProjectGithubActivityService,
    private readonly branchProtectionService: ProjectBranchProtectionService,
  ) {}

  /**
   * GET /projects/:id/commits?branch=&limit=&before=
   * `branch` defaults to dev (else the default branch), `limit` is 1-100
   * (default 30), `before` is the opaque `next` of the previous page.
   */
  @Get('projects/:id/commits')
  listCommits(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('branch') branch?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.commitsService.listCommits(
      id,
      this.requireUserId(req),
      this.oauthToken(req),
      req.session.user?.login ?? null,
      {
        ...(branch ? { branch } : {}),
        ...(limit === undefined || limit === ''
          ? {}
          : { limit: this.parseLimit(limit) }),
        ...(before ? { before } : {}),
      },
    );
  }

  /**
   * POST /projects/:id/audit/sync — read the repository's GitHub activity into
   * the Audit trail now, ignoring the 60 second throttle. Any member who can
   * see the repository may call it.
   */
  @Post('projects/:id/audit/sync')
  @Throttle({ default: { ttl: 60_000, limit: 12 } })
  syncAudit(@Req() req: Request, @Param('id') id: string) {
    return this.activityService.syncProject(
      id,
      this.requireUserId(req),
      this.oauthToken(req),
    );
  }

  /** POST /projects/:id/branch-protection — admin only, idempotent. */
  @Post('projects/:id/branch-protection')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  applyBranchProtection(@Req() req: Request, @Param('id') id: string) {
    return this.branchProtectionService.applyToProject(
      id,
      this.requireUserId(req),
      this.oauthToken(req),
    );
  }

  /**
   * POST /admin/branch-protection/apply — every provisioned repository the
   * caller can see; admin only, idempotent. One slow request by design (a few
   * GitHub calls per branch), hence the tight throttle.
   */
  @Post('admin/branch-protection/apply')
  @Throttle({ default: { ttl: 60_000, limit: 2 } })
  applyBranchProtectionToAll(@Req() req: Request) {
    return this.branchProtectionService.applyToAll(
      this.requireUserId(req),
      this.oauthToken(req),
    );
  }

  private parseLimit(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return Math.min(parsed, 100);
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
}
