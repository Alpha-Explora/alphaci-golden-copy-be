import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import {
  CI_RUN_VALIDATION,
  type CiRunValidationPort,
} from '#kernel/ports/ci-project.port';
import {
  ReleasesService,
  type ReleaseView,
} from '../application/releases.service';
import { StartReleaseDto } from './dto/start-release.dto';

/**
 * The release surface a generated pipeline calls.
 *
 * Authenticated by the project's ALPHACI_TOKEN, the same credential the
 * pipeline already uses to validate a run and report results - not a session,
 * because the caller is a workflow. It therefore carries no capability
 * decoration and is listed with the other CI integration routes in
 * tests/architecture/capability-route-coverage.spec.ts.
 *
 * It lives in Runtime rather than beside the other CI routes because Runtime
 * owns deployment targets and provider credentials, and Runtime already
 * depends on Pipelines. Putting it in Pipelines would point that dependency
 * both ways.
 */
@Controller('ci')
export class ReleasesController {
  constructor(
    private readonly releasesService: ReleasesService,
    @Inject(CI_RUN_VALIDATION)
    private readonly ciRunValidation: CiRunValidationPort,
  ) {}

  @Post('releases')
  @HttpCode(202)
  async startRelease(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: StartReleaseDto,
  ): Promise<ReleaseView> {
    const projectId = await this.authorize(authorization, body.repoFullName);

    return this.releasesService.startRelease({
      projectId,
      slot: body.slot,
      branch: body.branch,
      commitSha: body.commitSha,
      ...(body.artifact ? { artifact: body.artifact } : {}),
      ...(body.runUrl ? { runUrl: body.runUrl } : {}),
    });
  }

  @Get('releases/:releaseId')
  async getRelease(
    @Headers('authorization') authorization: string | undefined,
    @Param('releaseId') releaseId: string,
    @Query('repo') repo: string | undefined,
  ): Promise<ReleaseView> {
    // The repository is required here as well: the token alone says which
    // project it belongs to, and checking both keeps one validation path for
    // every call a pipeline makes.
    const projectId = await this.authorize(authorization, repo);

    return this.releasesService.getRelease({ projectId, releaseId });
  }

  private async authorize(
    authorization: string | undefined,
    repoFullName: string | undefined,
  ): Promise<string> {
    const token = this.extractBearerToken(authorization);
    if (!repoFullName?.trim()) {
      throw new UnauthorizedException(
        'The repository is required to authorize a release',
      );
    }

    // 'package' is the stage that builds and releases; validateRun also
    // enforces project status and entitlement, exactly as it does for a
    // report.
    const result = await this.ciRunValidation.validateRun({
      token,
      repoFullName: repoFullName.trim(),
      stage: 'package',
    });

    return result.projectId;
  }

  private extractBearerToken(authorization: string | undefined): string {
    const [scheme, value] = (authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value?.trim()) {
      throw new UnauthorizedException('A CI token is required');
    }

    return value.trim();
  }
}
