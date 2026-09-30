import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import type { ProvisionEnvVarsDto } from './dto/provision-env-vars.dto';
import {
  EnvVarsService,
  type ValidateEnvTextInput,
} from '../application/env-vars.service';

/**
 * Every route here is gated by EnvVarsService.assertHttpAccess (app_role
 * admin/lead, or platform admin, and project visibility — see
 * persona-access.rules.ts's canManageEnvVars) before the underlying method
 * runs. That gate lives here, at the HTTP boundary, rather than inside
 * provisionEnvVars/listEnvMetadata/validateEnvText/deleteEnvMetadata
 * themselves: provisionEnvVars in particular is also called directly by
 * provisioning's own env injection (ProjectDeploymentProvisioningService),
 * which must keep writing env vars unattended during project setup and
 * cross-linking, for whichever user triggered it — baking the lead/admin
 * check into the shared method would break that internal caller.
 */
@Controller('projects/:projectId/env-vars')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class EnvVarsController {
  constructor(private readonly service: EnvVarsService) {}

  @Get()
  async list(@Req() req: Request, @Param('projectId') projectId: string) {
    const userId = this.requireUserId(req);
    await this.service.assertHttpAccess(projectId, userId);
    return this.service.listEnvMetadata(projectId, userId);
  }

  @Post('provision')
  async provision(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ProvisionEnvVarsDto,
  ) {
    const userId = this.requireUserId(req);
    await this.service.assertHttpAccess(projectId, userId);
    return this.service.provisionEnvVars(projectId, userId, body);
  }

  @Post('validate')
  async validate(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ValidateEnvTextInput,
  ) {
    const userId = this.requireUserId(req);
    await this.service.assertHttpAccess(projectId, userId);
    return this.service.validateEnvText(projectId, userId, body);
  }

  @Delete(':metadataId')
  async remove(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('metadataId') metadataId: string,
  ) {
    const userId = this.requireUserId(req);
    await this.service.assertHttpAccess(projectId, userId);
    return this.service.deleteEnvMetadata(projectId, metadataId, userId);
  }

  private requireUserId(req: Request): string {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}
