import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import { ReleaseRegistryService } from '../application/release-registry.service';

/** A project's releases for signed-in users. */
@Controller('projects/:projectId/releases')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class ProjectReleasesController {
  constructor(private readonly releases: ReleaseRegistryService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.releases.listProjectReleases(projectId, req.session.user!.id);
  }
}
