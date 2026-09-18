import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CiService } from '../application/ci.service';
import { CiReportsService } from '../application/ci-reports.service';
import { CiReportBodyDto } from './dto/ci-report-body.dto';
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
    const validation = await this.ciService.validateRun({
      token,
      repoFullName: body.repoFullName,
      stage: body.stage,
    });

    return this.ciReportsService.ingestDeploymentGlobalReport(
      body,
      validation.projectId,
      validation.tenantId,
    );
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
