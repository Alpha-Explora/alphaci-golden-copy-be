import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import {
  QaRunsService,
  type QaRunActorContext,
} from '../application/qa-runs/qa-runs.service';
import { CreateQaRunDto } from '../application/qa-runs/dto/create-qa-run.dto';
import { PatchQaRunItemDto } from '../application/qa-runs/dto/patch-qa-run-item.dto';
import { RequestRetestDto } from '../application/qa-runs/dto/request-retest.dto';
import { SignoffQaRunDto } from '../application/qa-runs/dto/signoff-qa-run.dto';

function requireUserId(req: Request): string {
  const userId = req.session.user?.id ?? req.session.userId;
  if (!userId) {
    throw new UnauthorizedException('Authentication required');
  }
  return userId;
}

/**
 * SessionAuthGuard (run before every route here) always populates
 * `req.session.user` from `req.session.userId` when only the latter was
 * present, so `.login` is reliable on any request that got past the guard —
 * see session-auth.guard.ts.
 */
function requireUserLogin(req: Request): string {
  const login = req.session.user?.login;
  if (!login) {
    throw new UnauthorizedException('Authentication required');
  }
  return login;
}

function actorContext(req: Request): QaRunActorContext {
  return {
    userId: requireUserId(req),
    userLogin: requireUserLogin(req),
    oauthToken: req.session.githubAccessToken ?? null,
  };
}

function parseLimit(limit: string | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(limit, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * QA verification runs (Slice 3): per-(checklist, branch, commit) runs, their
 * items, and the sign-off/reopen lifecycle. Entirely project-scoped — unlike
 * the checklist definitions in qa-checklists.controller.ts, there is no
 * workspace-scoped route here.
 */
@Controller('projects/:projectId/qa-runs')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class ProjectQaRunsController {
  constructor(private readonly qaRunsService: QaRunsService) {}

  @Get()
  list(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('branch') branch?: string,
    @Query('checklistId') checklistId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.qaRunsService.listForProject(projectId, requireUserId(req), {
      branch,
      checklistId,
      limit: parseLimit(limit),
    });
  }

  // Declared before ':runId' so Nest/Express match this literal segment
  // first — a run id can never collide with the literal 'current', but
  // route declaration order still matters for how they are matched.
  @Get('current')
  current(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query('branch') branch?: string,
    @Query('checklistId') checklistId?: string,
  ) {
    return this.qaRunsService.current(
      projectId,
      actorContext(req),
      branch ?? '',
      checklistId,
    );
  }

  @Post()
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('projectId') projectId: string,
    @Body() body: CreateQaRunDto,
  ) {
    const { created, run } = await this.qaRunsService.create(
      projectId,
      actorContext(req),
      body,
    );
    res.status(created ? 201 : 200);
    return run;
  }

  @Get(':runId')
  getById(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaRunsService.getById(projectId, requireUserId(req), runId);
  }

  @Patch(':runId/items/:itemId')
  updateItem(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
    @Body() body: PatchQaRunItemDto,
  ) {
    return this.qaRunsService.updateItem(
      projectId,
      actorContext(req),
      runId,
      itemId,
      body,
    );
  }

  @Post(':runId/items/:itemId/request-retest')
  requestRetest(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
    @Body() body: RequestRetestDto,
  ) {
    return this.qaRunsService.requestRetest(
      projectId,
      actorContext(req),
      runId,
      itemId,
      body,
    );
  }

  @Post(':runId/signoff')
  signoff(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Body() body: SignoffQaRunDto,
  ) {
    return this.qaRunsService.signoff(
      projectId,
      actorContext(req),
      runId,
      body,
    );
  }

  @Post(':runId/reopen')
  reopen(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaRunsService.reopen(projectId, requireUserId(req), runId);
  }
}

/** Cross-run "needs your attention" feed: returned_to_dev items across the project's open runs. */
@Controller('projects/:projectId/qa-returned-items')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class ProjectQaReturnedItemsController {
  constructor(private readonly qaRunsService: QaRunsService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.qaRunsService.listReturnedItems(projectId, requireUserId(req));
  }
}
