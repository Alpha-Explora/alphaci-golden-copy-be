import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { CiService } from '../application/ci.service';
import {
  VisualRegressionService,
  type UploadedVisualFile,
} from '../application/visual-regression.service';
import { VISUAL_MAX_PNG_BYTES } from '../application/visual-regression.rules';
import { CiActiveTokenGuard, extractBearerToken } from './ci-bearer';
import {
  VisualBaselineFileQueryDto,
  VisualBaselinesQueryDto,
  VisualResultFileFieldsDto,
  VisualSummaryBodyDto,
} from './dto/visual.dto';

/**
 * The three calls the generated Playwright job makes for ALPHACI-stored visual
 * baselines (opt-in `visual-baselines: true` on playwright-e2e.yml).
 *
 * Authorized exactly like `POST /ci/report`: the ALPHACI_TOKEN bearer must be
 * the active token of a provisioned, entitled project whose repository is the
 * one named in the request (CiService.validateRun). The stage is always
 * `verify`, the stage that runs Playwright. Everything is then stored under the
 * project's canonical repository name that validation returns, never the
 * caller's spelling.
 */
@Controller('ci')
export class CiVisualController {
  constructor(
    private readonly ciService: CiService,
    private readonly visualService: VisualRegressionService,
  ) {}

  /** GET /api/v1/ci/visual-baselines?repoFullName=&branch= */
  @Get('visual-baselines')
  async listBaselines(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: VisualBaselinesQueryDto,
  ) {
    const repoFullName = await this.authorize(
      authorization,
      query.repoFullName,
    );
    return this.visualService.listBaselinesForPipeline(
      repoFullName,
      query.branch,
    );
  }

  /** GET /api/v1/ci/visual-baselines/file?repoFullName=&branch=&name= -> image/png */
  @Get('visual-baselines/file')
  async getBaselineFile(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: VisualBaselineFileQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const repoFullName = await this.authorize(
      authorization,
      query.repoFullName,
    );
    const png = await this.visualService.readBaselineForPipeline(
      repoFullName,
      query.branch,
      query.name,
    );
    // A baseline can be re-approved at any moment; the pipeline reads it once
    // per run and must never see a cached older one.
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(png, { type: 'image/png' });
  }

  /** POST /api/v1/ci/visual-summary */
  @Post('visual-summary')
  @HttpCode(200)
  async ingestSummary(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: VisualSummaryBodyDto,
  ) {
    const repoFullName = await this.authorize(authorization, body.repoFullName);
    return this.visualService.ingestSummary(repoFullName, body);
  }

  /**
   * POST /api/v1/ci/visual-results/file (multipart)
   *
   * Guard order matters: the active-token guard runs before the multipart
   * interceptor, which would otherwise buffer the file for an anonymous caller.
   * Multer's own limits bound what a token holder can make us buffer (one file,
   * 3 MB, a handful of short text fields); an oversize file is a 413.
   */
  @Post('visual-results/file')
  @HttpCode(200)
  @UseGuards(CiActiveTokenGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: VISUAL_MAX_PNG_BYTES,
        files: 1,
        fields: 10,
        fieldSize: 2048,
        parts: 12,
      },
    }),
  )
  async ingestFile(
    @Headers('authorization') authorization: string | undefined,
    @Body() fields: VisualResultFileFieldsDto,
    @UploadedFile() file: UploadedVisualFile | undefined,
  ) {
    const repoFullName = await this.authorize(
      authorization,
      fields.repoFullName,
    );
    return this.visualService.ingestFile(repoFullName, fields, file);
  }

  /** Token -> repository binding; returns the project's canonical repo name. */
  private async authorize(
    authorization: string | undefined,
    repoFullName: string,
  ): Promise<string> {
    const validated = await this.ciService.validateRun({
      token: extractBearerToken(authorization),
      repoFullName,
      stage: 'verify',
    });
    return validated.repoFullName;
  }
}
