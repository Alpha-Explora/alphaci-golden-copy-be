import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import {
  ProjectPlaywrightLiveService,
  type PlaywrightLiveBranch,
} from '../application/playwright-live/project-playwright-live.service';

const BRANCHES: readonly PlaywrightLiveBranch[] = ['uat', 'main'];

/**
 * The studio Playwright tab's live read: stage, each test as it finishes,
 * what is running now. Safe to poll every few seconds (GitHub reads are
 * cached server side). Access (project visibility) lives in the service.
 */
@Controller('projects/:projectId/workspace/playwright-live')
@UseGuards(SessionAuthGuard)
export class ProjectPlaywrightLiveController {
  constructor(private readonly liveService: ProjectPlaywrightLiveService) {}

  @Get()
  getLive(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('branch') branch?: string,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    const requested = branch === undefined || branch === '' ? 'uat' : branch;
    const parsed = BRANCHES.find((candidate) => candidate === requested);
    if (!parsed) {
      throw new BadRequestException('branch must be uat or main.');
    }
    return this.liveService.getLive(
      projectId,
      userId,
      req.session.githubAccessToken ?? null,
      parsed,
    );
  }
}
