import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import { OnpremReadinessService } from '../application/onprem/onprem-readiness.service';

@Controller('projects/:projectId/environments/:environmentId')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class OnpremReadinessController {
  constructor(private readonly readiness: OnpremReadinessService) {}
  @Get('onprem-readiness')
  read(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Req() req: Request,
  ) {
    return this.readiness.read(projectId, environmentId, req.session.user!.id);
  }
}
