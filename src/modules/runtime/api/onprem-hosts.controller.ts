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
import { OnpremHostsService } from '../application/onprem/onprem-hosts.service';
import { CreateEnrollmentDto, RevokeMachineDto } from './dto/onprem-host.dto';

@Controller('workspaces/:workspaceId')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class OnpremHostsController {
  constructor(private readonly hosts: OnpremHostsService) {}
  @Get('onprem-hosts')
  list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Req() req: Request,
  ) {
    return this.hosts.list(workspaceId, req.session.user!.id);
  }
  @Post('onprem-host-enrollments')
  enroll(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Req() req: Request,
    @Body() input: CreateEnrollmentDto,
  ) {
    return this.hosts.createEnrollment(
      workspaceId,
      req.session.user!.id,
      input,
    );
  }
  @Post('onprem-hosts/:machineId/revoke')
  revoke(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('machineId', ParseUUIDPipe) machineId: string,
    @Req() req: Request,
    @Body() body: RevokeMachineDto = {},
  ) {
    return this.hosts.revoke(
      workspaceId,
      machineId,
      req.session.user!.id,
      body.replacementMachineId ?? null,
    );
  }
}
