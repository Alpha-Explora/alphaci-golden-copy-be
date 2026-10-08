import {
  Body,
  Controller,
  Headers,
  HttpCode,
  PayloadTooLargeException,
  Post,
} from '@nestjs/common';

import { CiService } from '../application/ci.service';
import { PlaywrightLiveService } from '../application/playwright-live.service';
import { PLAYWRIGHT_LIVE_MAX_BODY_BYTES } from '../application/playwright-live.rules';
import { extractBearerToken } from './ci-bearer';
import { PlaywrightProgressBodyDto } from './dto/playwright-progress.dto';

/**
 * The generated Playwright job's live reporter posts here while tests run.
 *
 * Authorized exactly like the visual ingestion calls and `POST /ci/report`:
 * the ALPHACI_TOKEN bearer must be the active token of a provisioned, entitled
 * project whose repository is the one named in the body (CiService.validateRun;
 * a mismatch is a 403). Everything is stored under the project's canonical
 * repository name that validation returns, never the caller's spelling.
 */
@Controller('ci')
export class CiPlaywrightProgressController {
  constructor(
    private readonly ciService: CiService,
    private readonly liveService: PlaywrightLiveService,
  ) {}

  /** POST /api/v1/ci/playwright-progress -> 202 { accepted } */
  @Post('playwright-progress')
  @HttpCode(202)
  async ingest(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: PlaywrightProgressBodyDto,
  ) {
    const validated = await this.ciService.validateRun({
      token: extractBearerToken(authorization),
      repoFullName: body.repoFullName,
      stage: 'verify',
    });
    if (
      Buffer.byteLength(JSON.stringify(body), 'utf8') >
      PLAYWRIGHT_LIVE_MAX_BODY_BYTES
    ) {
      throw new PayloadTooLargeException(
        'A progress batch must be at most 256 KB.',
      );
    }
    return this.liveService.ingest(validated.repoFullName, body);
  }
}
