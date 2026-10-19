import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { AcceptQaRunItemDto } from '../application/qa-runs/dto/accept-qa-run-item.dto';
import { DispatchProjectRunDto } from '../application/qa-runs/dto/dispatch-project-run.dto';
import { PatchQaRunItemDto } from '../application/qa-runs/dto/patch-qa-run-item.dto';
import { PatchRunTestCaseDto } from '../application/qa-runs/dto/patch-run-test-case.dto';
import { SignoffQaRunDto } from '../application/qa-runs/dto/signoff-qa-run.dto';
import { QaAutomationDispatchService } from '../application/qa-runs/qa-automation-dispatch.service';
import {
  buildQaProjectReportFilename,
  renderQaProjectReportMarkdown,
} from '../application/qa-runs/qa-project-report';
import { QaProjectRunsService } from '../application/qa-runs/qa-project-runs.service';
import {
  QA_REPORT_XLSX_CONTENT_TYPE,
  renderQaReportWorkbook,
} from '../application/qa-runs/qa-report.workbook';
import {
  actorContext,
  parseLimit,
  parseReportFormat,
  requireUserId,
} from './qa-runs.controller';

/**
 * Project QA runs: QA verifies once per Project, against the uat head of every
 * repository captured when the run starts. Visibility is "active member of the
 * Project's group" (a non-member gets 404); the persona gates live in
 * QaProjectRunsService.
 */
@Controller('delivery-projects/:deliveryProjectId/qa-runs')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class DeliveryProjectQaRunsController {
  constructor(
    private readonly qaProjectRunsService: QaProjectRunsService,
    private readonly qaAutomationDispatchService: QaAutomationDispatchService,
  ) {}

  @Get()
  list(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.qaProjectRunsService.list(
      deliveryProjectId,
      requireUserId(req),
      {
        limit: parseLimit(limit),
        cursor,
      },
    );
  }

  // Declared before ':runId' so the literal segment matches first.
  @Get('current')
  current(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    return this.qaProjectRunsService.current(
      deliveryProjectId,
      actorContext(req),
    );
  }

  /** No body: the server resolves every repository's uat head. 201 when created, 200 when that set of heads already had a run. */
  @Post()
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    const result = await this.qaProjectRunsService.create(
      deliveryProjectId,
      actorContext(req),
    );
    res.status(result.created ? 201 : 200);
    return result;
  }

  @Get(':runId')
  getById(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaProjectRunsService.getById(
      deliveryProjectId,
      actorContext(req),
      runId,
    );
  }

  /** qa-report/v2, JSON, Markdown or Excel, downloaded as an attachment. */
  @Get(':runId/report')
  async report(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Query('format') formatParam?: string,
  ): Promise<StreamableFile> {
    const format = parseReportFormat(formatParam);
    const report = await this.qaProjectRunsService.buildReport(
      deliveryProjectId,
      actorContext(req),
      runId,
    );
    const disposition = `attachment; filename="${buildQaProjectReportFilename(report, format)}"`;

    if (format === 'md') {
      return new StreamableFile(
        Buffer.from(renderQaProjectReportMarkdown(report), 'utf8'),
        { type: 'text/markdown; charset=utf-8', disposition },
      );
    }
    if (format === 'xlsx') {
      return new StreamableFile(await renderQaReportWorkbook(report), {
        type: QA_REPORT_XLSX_CONTENT_TYPE,
        disposition,
      });
    }
    return new StreamableFile(
      Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
      { type: 'application/json; charset=utf-8', disposition },
    );
  }

  @Patch(':runId/items/:itemId')
  updateItem(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
    @Body() body: PatchQaRunItemDto,
  ) {
    return this.qaProjectRunsService.updateItem(
      deliveryProjectId,
      actorContext(req),
      runId,
      itemId,
      body,
    );
  }

  /** QA's result on one test case of a story (pending, passed, failed, blocked, not_applicable). */
  @Patch(':runId/items/:itemId/test-cases/:testCaseId')
  updateTestCase(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
    @Param('testCaseId') testCaseId: string,
    @Body() body: PatchRunTestCaseDto,
  ) {
    return this.qaProjectRunsService.updateTestCase(
      deliveryProjectId,
      actorContext(req),
      runId,
      itemId,
      testCaseId,
      body,
    );
  }

  /**
   * The Product owner passes or fails one item of a signed-off run
   * (ADR-0014, amendment 12). Failing reopens the run and returns the story
   * to the Developers.
   */
  @Patch(':runId/items/:itemId/acceptance')
  acceptItem(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
    @Body() body: AcceptQaRunItemDto,
  ) {
    return this.qaProjectRunsService.acceptItem(
      deliveryProjectId,
      actorContext(req),
      runId,
      itemId,
      body,
    );
  }

  @Post(':runId/signoff')
  signoff(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Body() body: SignoffQaRunDto,
  ) {
    return this.qaProjectRunsService.signoff(
      deliveryProjectId,
      actorContext(req),
      runId,
      body,
    );
  }

  @Post(':runId/reopen')
  reopen(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
  ) {
    return this.qaProjectRunsService.reopen(
      deliveryProjectId,
      actorContext(req),
      runId,
    );
  }

  /**
   * "Run Playwright": re-dispatches the generated verify workflow in every
   * repository the run covers (or just `projectId`), using the signed-in
   * user's own OAuth token so the run is attributed to them.
   */
  @Post(':runId/automation/dispatch')
  @HttpCode(202)
  dispatchAutomation(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Body() body: DispatchProjectRunDto,
  ) {
    return this.qaAutomationDispatchService.dispatch(
      deliveryProjectId,
      actorContext(req),
      runId,
      body,
    );
  }
}

/**
 * Project-wide "My QA items": every developer's items, not filtered by user.
 * Any group member may read it; the UI shows it to developers and QA.
 */
@Controller('delivery-projects/:deliveryProjectId/qa/my-items')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class DeliveryProjectQaMyItemsController {
  constructor(private readonly qaProjectRunsService: QaProjectRunsService) {}

  @Get()
  list(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    return this.qaProjectRunsService.myItems(
      deliveryProjectId,
      actorContext(req),
    );
  }
}
