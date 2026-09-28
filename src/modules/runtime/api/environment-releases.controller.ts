import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import { ReleaseRegistryService } from '../application/release-registry.service';
import {
  CreateOnpremHostDto,
  PromoteReleaseDto,
} from './dto/release-registry.dto';

/** Signed-in release operations for one project environment. */
@Controller('projects/:projectId/environments/:environmentId')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class EnvironmentReleasesController {
  constructor(private readonly releases: ReleaseRegistryService) {}

  /** The environment's deployment history, newest first. */
  @Get('deployments')
  deployments(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
  ) {
    return this.releases.listEnvironmentDeployments(
      projectId,
      environmentId,
      req.session.user!.id,
    );
  }

  /** Deploy a release to this environment from the one before it. */
  @Post('promotions')
  promote(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Body() body: PromoteReleaseDto,
  ) {
    return this.releases.promote({
      projectId,
      environmentId,
      releaseId: body.releaseId,
      userId: req.session.user!.id,
    });
  }

  /** Register an on-prem host for this environment; the response holds its only copy of the token. */
  @Post('hosts')
  createHost(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Body() body: CreateOnpremHostDto,
  ) {
    return this.releases.createHost({
      projectId,
      environmentId,
      userId: req.session.user!.id,
      name: body.name,
    });
  }
}
