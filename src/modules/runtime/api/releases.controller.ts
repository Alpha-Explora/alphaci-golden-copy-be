import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';

import {
  CI_RUN_VALIDATION,
  type CiRunValidationPort,
} from '#kernel/ports/ci-project.port';
import {
  ReleasesService,
  type ReleaseView,
} from '../application/releases.service';
import {
  ReleaseRegistryService,
  type ReleaseRegistryView,
} from '../application/release-registry.service';
import type { EnvironmentDeploymentRecord } from '../infrastructure/repositories/release-registry.repository';
import { StartReleaseDto } from './dto/start-release.dto';
import {
  AttachManifestDto,
  CiReportDeploymentStatusDto,
  RegisterReleaseDto,
} from './dto/release-registry.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The global pipe cannot choose between the two request shapes, so the
// release route validates its body with the same options once it has.
const bodyPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

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
    private readonly releaseRegistry: ReleaseRegistryService,
    @Inject(CI_RUN_VALIDATION)
    private readonly ciRunValidation: CiRunValidationPort,
  ) {}

  /**
   * A body naming `sourceEnvironmentId` registers an immutable release for
   * the project's first environment. Any other body is the legacy request
   * that releases a branch build to its target.
   */
  @Post('releases')
  @HttpCode(202)
  async startRelease(
    @Headers('authorization') authorization: string | undefined,
    @Body() raw: Record<string, unknown>,
  ): Promise<ReleaseView | ReleaseRegistryView> {
    if (raw && typeof raw === 'object' && 'sourceEnvironmentId' in raw) {
      const body = (await bodyPipe.transform(raw, {
        type: 'body',
        metatype: RegisterReleaseDto,
      })) as RegisterReleaseDto;
      const projectId = await this.authorize(authorization, body.repoFullName);
      return this.releaseRegistry.registerRelease({
        projectId,
        repoFullName: body.repoFullName,
        sourceEnvironmentId: body.sourceEnvironmentId,
        sourceBranch: body.sourceBranch,
        commitSha: body.commitSha,
        artifacts: body.artifacts,
        workflowRun: { ...body.workflowRun },
      });
    }

    const body = (await bodyPipe.transform(raw, {
      type: 'body',
      metatype: StartReleaseDto,
    })) as StartReleaseDto;
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
  ): Promise<ReleaseView | ReleaseRegistryView> {
    // The repository is required here as well: the token alone says which
    // project it belongs to, and checking both keeps one validation path for
    // every call a pipeline makes.
    const projectId = await this.authorize(authorization, repo);

    if (UUID.test(releaseId)) {
      return this.releaseRegistry.getRelease(projectId, releaseId);
    }
    return this.releasesService.getRelease({ projectId, releaseId });
  }

  /** Attach the manifest CI signed for a registered release. */
  @Put('releases/:releaseId/manifest')
  async attachManifest(
    @Headers('authorization') authorization: string | undefined,
    @Param('releaseId', ParseUUIDPipe) releaseId: string,
    @Body() body: AttachManifestDto,
  ): Promise<ReleaseRegistryView> {
    const projectId = await this.authorize(authorization, body.repoFullName);
    return this.releaseRegistry.attachManifest(projectId, releaseId, {
      manifest: body.manifest,
      manifestSha256: body.manifestSha256,
      signature: { ...body.signature },
    });
  }

  /** Report the first environment's automatic deployment of a release. */
  @Post('releases/:releaseId/deployment-status')
  @HttpCode(200)
  async reportDeployment(
    @Headers('authorization') authorization: string | undefined,
    @Param('releaseId', ParseUUIDPipe) releaseId: string,
    @Body() body: CiReportDeploymentStatusDto,
  ): Promise<EnvironmentDeploymentRecord> {
    const projectId = await this.authorize(authorization, body.repoFullName);
    return this.releaseRegistry.reportAutomaticDeployment(
      projectId,
      releaseId,
      body.status,
      body.detail ?? null,
    );
  }

  /** Report a promoted deployment the generated promotion workflow is running. */
  @Post('deployments/:deploymentId/status')
  @HttpCode(200)
  async reportPromotion(
    @Headers('authorization') authorization: string | undefined,
    @Param('deploymentId', ParseUUIDPipe) deploymentId: string,
    @Body() body: CiReportDeploymentStatusDto,
  ): Promise<EnvironmentDeploymentRecord> {
    const projectId = await this.authorize(authorization, body.repoFullName);
    return this.releaseRegistry.reportPromotionDeployment(
      projectId,
      deploymentId,
      body.status,
      body.detail ?? null,
    );
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
