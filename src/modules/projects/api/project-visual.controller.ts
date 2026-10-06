import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import type { VisualImageKind } from '#kernel/ports/visual-regression.port';
import {
  ProjectVisualService,
  type VisualBranch,
} from '../application/visual/project-visual.service';
import { ApproveVisualBaselinesDto } from './dto/approve-visual-baselines.dto';

const BRANCHES: readonly VisualBranch[] = ['uat', 'main'];
const KINDS: readonly VisualImageKind[] = ['baseline', 'actual', 'diff'];
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,115}\.png$/;

/**
 * The Visual tab's data: the latest Playwright run's screenshots against the
 * approved baselines, the images themselves, and approving a change.
 *
 * Kept thin: access (project visibility, the approver allow-list) lives in
 * ProjectVisualService. Mounted under the workspace path so the tab reads
 * beside Code, Pull requests and Pipeline runs, but its own controller
 * because, unlike those, nothing here calls GitHub.
 *
 *   GET  visual           - latest (or named) run for a branch; safe to poll
 *   GET  visual/image     - one PNG, cacheable for five minutes
 *   POST visual/approve   - promote changed/new snapshots to baselines
 */
@Controller('projects/:projectId/workspace/visual')
@UseGuards(SessionAuthGuard)
export class ProjectVisualController {
  constructor(private readonly visualService: ProjectVisualService) {}

  @Get()
  getVisual(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('branch') branch?: string,
    @Query('runId') runId?: string,
  ) {
    return this.visualService.getLatest(
      projectId,
      this.requireUserId(req),
      this.requireBranch(branch),
      this.optionalRunId(runId),
    );
  }

  @Get('image')
  async getImage(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('kind') kind?: string,
    @Query('branch') branch?: string,
    @Query('runId') runId?: string,
    @Query('name') name?: string,
  ): Promise<StreamableFile> {
    const parsedKind = KINDS.find((candidate) => candidate === kind);
    if (!parsedKind) {
      throw new BadRequestException('kind must be baseline, actual or diff.');
    }
    if (!name || !SNAPSHOT_NAME.test(name)) {
      throw new BadRequestException('name must be a safe .png snapshot name.');
    }
    const parsedRunId = this.optionalRunId(runId);
    if (parsedKind !== 'baseline' && parsedRunId === undefined) {
      throw new BadRequestException('runId is required for actual and diff.');
    }

    const png = await this.visualService.getImage(
      projectId,
      this.requireUserId(req),
      {
        kind: parsedKind,
        branch: this.requireBranch(branch),
        name,
        ...(parsedRunId !== undefined && { runId: parsedRunId }),
      },
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    return new StreamableFile(png, { type: 'image/png' });
  }

  @Post('approve')
  @HttpCode(200)
  approve(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ApproveVisualBaselinesDto,
  ) {
    return this.visualService.approve(
      projectId,
      this.requireUserId(req),
      req.session.user?.login ?? null,
      body,
    );
  }

  private requireUserId(req: Request): string {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }

  private requireBranch(value: string | undefined): VisualBranch {
    const branch = BRANCHES.find((candidate) => candidate === value);
    if (!branch) {
      throw new BadRequestException('branch must be uat or main.');
    }
    return branch;
  }

  private optionalRunId(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    if (!/^\d{1,15}$/.test(value)) {
      throw new BadRequestException('runId must be a positive integer.');
    }
    return Number(value);
  }
}
