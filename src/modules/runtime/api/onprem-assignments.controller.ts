import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsObject, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import type { AssignmentRequestConfig } from '#kernel/ports/onprem-assignment.port';
import { OnpremAssignmentsService } from '../application/onprem/onprem-assignments.service';
class AssignDto {
  /** Omitted when the workspace has a single healthy machine. */
  @IsOptional() @IsUUID() machineId?: string;
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsUUID()
  expectedAssignmentId!: string | null;
  @IsUUID() requestId!: string;
  @IsObject() config!: AssignmentRequestConfig;
}
class UnassignDto {
  @IsUUID() expectedAssignmentId!: string;
}
@Controller('projects/:projectId/environments/:environmentId/host-assignment')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class OnpremAssignmentsController {
  constructor(private readonly assignments: OnpremAssignmentsService) {}
  @Get()
  current(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Req() req: Request,
  ) {
    return this.assignments.current(
      projectId,
      environmentId,
      req.session.user!.id,
    );
  }
  @Post()
  assign(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Req() req: Request,
    @Body() body: AssignDto,
  ) {
    return this.assignments.assign(
      projectId,
      environmentId,
      req.session.user!.id,
      body,
    );
  }
  @Delete()
  unassign(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Req() req: Request,
    @Body() body: UnassignDto,
  ) {
    return this.assignments.unassign(
      projectId,
      environmentId,
      req.session.user!.id,
      body.expectedAssignmentId,
    );
  }
}
