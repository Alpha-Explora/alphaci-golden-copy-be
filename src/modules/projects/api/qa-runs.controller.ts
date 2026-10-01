import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import {
  QaRunsService,
  type QaRunActorContext,
} from '../application/qa-runs/qa-runs.service';
import { RequestRetestDto } from '../application/qa-runs/dto/request-retest.dto';
import { QaPromotionService } from '../application/qa-runs/qa-promotion.service';
import { QaReportService } from '../application/qa-runs/qa-report.service';
import { buildQaReportFilename } from '../application/qa-runs/qa-report.filename';
import { renderQaReportMarkdown } from '../application/qa-runs/qa-report.markdown';
import type { QaReportFormat } from '../application/qa-runs/qa-report.contracts';

/** `format` query param on GET .../report: defaults to 'json', anything else is a 400. */
function parseReportFormat(raw: string | undefined): QaReportFormat {
  if (raw === undefined || raw === 'json') {
    return 'json';
  }
  if (raw === 'md' || raw === 'markdown') {
    return 'md';
  }
  throw new BadRequestException(
    `Unsupported report format "${raw}"; use "json" or "md".`,
  );
}

export function requireUserId(req: Request): string {
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

export function actorContext(req: Request): QaRunActorContext {
  return {
    userId: requireUserId(req),
    userLogin: requireUserLogin(req),
    oauthToken: req.session.githubAccessToken ?? null,
  };
}

export function parseLimit(limit: string | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(limit, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Repository-scope QA runs, DEPRECATED and read-only history: QA verifies once
 * per Project now (see qa-project-runs.controller.ts). The reads stay so
 * history remains visible; every write answers 409 QA_RUN_LEGACY_READONLY,
 * except request-retest, which on a Project run is an alias that sets the
 * item's Progress to done. Entirely project-scoped - there is no
 * workspace-scoped route here.
 */
@Controller('projects/:projectId/qa-runs')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class ProjectQaRunsController {
  constructor(
    private readonly qaRunsService: QaRunsService,
    private readonly qaReportService: QaReportService,
  ) {}

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

  /** Refused: start the Project's run instead. The legacy body is not read. */
  @Post()
  create(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.qaRunsService.create(projectId, actorContext(req));
  }

  @Get(':runId')
  getById(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaRunsService.getById(projectId, requireUserId(req), runId);
  }

  /**
   * QA report export (Slice 4): JSON or Markdown, downloaded as an
   * attachment. StreamableFile's `type`/`disposition` set Content-Type /
   * Content-Disposition verbatim on the response (see
   * ExpressAdapter.reply) -- no @Res({ passthrough: false }) needed.
   */
  @Get(':runId/report')
  async report(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Query('format') formatParam?: string,
  ): Promise<StreamableFile> {
    const format = parseReportFormat(formatParam);
    const report = await this.qaReportService.build(
      projectId,
      requireUserId(req),
      runId,
    );
    const filename = buildQaReportFilename(report, format);
    const disposition = `attachment; filename="${filename}"`;

    if (format === 'md') {
      return new StreamableFile(
        Buffer.from(renderQaReportMarkdown(report), 'utf8'),
        { type: 'text/markdown; charset=utf-8', disposition },
      );
    }
    return new StreamableFile(
      Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
      { type: 'application/json; charset=utf-8', disposition },
    );
  }

  @Patch(':runId/items/:itemId')
  updateItem(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaRunsService.refuseWrite(projectId, actorContext(req), runId);
  }

  /** On a Project run: an alias that sets the item's Progress to done. */
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
  ) {
    return this.qaRunsService.refuseWrite(projectId, actorContext(req), runId);
  }

  @Post(':runId/reopen')
  reopen(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaRunsService.refuseWrite(projectId, actorContext(req), runId);
  }

  @Post(':runId/automation/dispatch')
  @HttpCode(202)
  dispatchAutomation(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaRunsService.refuseWrite(projectId, actorContext(req), runId);
  }
}

/** DEPRECATED: returned items of the repository's Project; read the Project-wide feed instead. */
@Controller('projects/:projectId/qa-returned-items')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class ProjectQaReturnedItemsController {
  constructor(private readonly qaRunsService: QaRunsService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.qaRunsService.listReturnedItems(projectId, actorContext(req));
  }
}

/**
 * DEPRECATED Overview "My QA items" card (Slice 6), derived from the
 * repository's Project. The Project-wide feed is
 * GET /delivery-projects/:id/qa/my-items.
 */
@Controller('projects/:projectId/qa-my-items')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class ProjectQaMyItemsController {
  constructor(private readonly qaRunsService: QaRunsService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.qaRunsService.listMyItems(projectId, actorContext(req));
  }
}

/**
 * QA promotion (Slice 6, "Merge to main"): the gate that decides whether a
 * QA-approved uat commit may go to main, and the merge action itself. The gate
 * is per Project. GET is readable by anyone who can see the project; POST is
 * lead|admin only, enforced inside QaPromotionService (a 403 there, not a 404
 * -- unlike checklist workspace-scoping, project visibility was already
 * established by the same GET this pairs with).
 */
@Controller('projects/:projectId/qa/promotion')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class ProjectQaPromotionController {
  constructor(private readonly qaPromotionService: QaPromotionService) {}

  @Get()
  status(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.qaPromotionService.getStatus(projectId, actorContext(req));
  }

  @Post('merge')
  @HttpCode(200)
  merge(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.qaPromotionService.merge(projectId, actorContext(req));
  }
}
