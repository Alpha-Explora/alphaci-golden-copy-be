import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CiService } from '../application/ci.service';
import { CiReportsService } from '../application/ci-reports.service';
import {
  buildCiRunReportFilename,
  renderCiRunReportMarkdown,
} from '../application/ci-run-report';
import { CiReportBodyDto } from './dto/ci-report-body.dto';
import { GetRunReportQueryDto } from './dto/get-run-report-query.dto';
import { GetRunsQueryDto } from './dto/get-runs-query.dto';
import type { ValidateCiRunDto } from './dto/validate-ci-run.dto';

@Controller('ci')
export class CiController {
  constructor(
    private readonly ciService: CiService,
    private readonly ciReportsService: CiReportsService,
  ) {}

  @Post('validate')
  @HttpCode(200)
  async validate(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ValidateCiRunDto,
  ) {
    const token = this.extractBearerToken(authorization);
    const input = {
      token,
      repoFullName: body.repo,
      stage: body.stage,
      ...(body.workflowRunId !== undefined && {
        workflowRunId: body.workflowRunId,
      }),
      ...(body.headSha !== undefined && { headSha: body.headSha }),
    };

    return this.ciService.validateRun(input);
  }

  /**
   * POST /api/v1/ci/report
   * Ingests a CI stage run report from the generated workflow.
   * Authenticated via ALPHACI_TOKEN bearer — same mechanism as /ci/validate.
   */
  @Post('report')
  @HttpCode(200)
  async ingestReport(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: CiReportBodyDto,
  ) {
    // Verify the ALPHACI_TOKEN is valid for this repo before accepting the report
    const token = this.extractBearerToken(authorization);
    await this.ciService.validateRun({
      token,
      repoFullName: body.repoFullName,
      stage: body.stage,
    });

    return this.ciReportsService.ingestReport(body);
  }

  /**
   * GET /api/v1/ci/runs?repoFullName=owner/repo
   * Returns the last ~50 grouped run reports for a repository.
   * Authenticated via session — ownership is verified inside the service.
   */
  @Get('runs')
  @UseGuards(SessionAuthGuard)
  async getRuns(@Req() req: Request, @Query() query: GetRunsQueryDto) {
    // SessionAuthGuard guarantees req.session.user is populated before this runs.
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.ciReportsService.getRuns(
      userId,
      query.repoFullName,
      query.limit,
      query.offset,
      query.workspaceId,
    );
  }

  /**
   * GET /api/v1/ci/runs/report?repoFullName=&branch=&commitSha=&format=json|md
   * One pipeline execution as a downloadable report, failures first. Declared
   * as a literal beside `runs`; same session auth and project visibility.
   * StreamableFile's `type`/`disposition` set Content-Type and
   * Content-Disposition verbatim, as the QA report export does.
   */
  @Get('runs/report')
  @UseGuards(SessionAuthGuard)
  async getRunReport(
    @Req() req: Request,
    @Query() query: GetRunReportQueryDto,
  ): Promise<StreamableFile> {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const report = await this.ciReportsService.getRunReport(
      userId,
      query.repoFullName,
      query.branch,
      query.commitSha,
    );
    const format =
      query.format === 'md' || query.format === 'markdown' ? 'md' : 'json';
    const disposition = `attachment; filename="${buildCiRunReportFilename(report, format)}"`;

    if (format === 'md') {
      return new StreamableFile(
        Buffer.from(renderCiRunReportMarkdown(report), 'utf8'),
        { type: 'text/markdown; charset=utf-8', disposition },
      );
    }
    return new StreamableFile(
      Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
      { type: 'application/json; charset=utf-8', disposition },
    );
  }

  private extractBearerToken(authorization: string | undefined): string {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) {
      throw new UnauthorizedException('Bearer CI token is required');
    }

    return match[1].trim();
  }
}
