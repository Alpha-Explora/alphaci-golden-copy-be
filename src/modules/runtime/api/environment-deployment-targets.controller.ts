import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import { DeploymentTargetsService } from '../application/deployment-targets.service';

/** Where an environment deploys: its target for one slot, with its URLs. */
@Controller(
  'projects/:projectId/environments/:environmentId/deployment-targets',
)
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class EnvironmentDeploymentTargetsController {
  constructor(private readonly service: DeploymentTargetsService) {}

  @Get(':slot')
  find(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Param('slot') slot: string,
  ) {
    return this.service.getEnvironmentTarget(
      projectId,
      environmentId,
      slot,
      req.session.user!.id,
    );
  }
}
