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

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import type { ProvisionEnvVarsDto } from './dto/provision-env-vars.dto';
import { EnvFeatureGuard } from './env-feature.guard';
import { EnvVarsService, type ValidateEnvTextInput } from './env-vars.service';

@Controller('projects/:projectId/env-vars')
@UseGuards(SessionAuthGuard, SubscriptionGuard, EnvFeatureGuard)
export class EnvVarsController {
  constructor(private readonly service: EnvVarsService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.service.listEnvMetadata(projectId, userId);
  }

  @Post('provision')
  provision(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ProvisionEnvVarsDto,
  ) {
    return this.service.provisionEnvVars(projectId, req.session.user!.id, body);
  }

  @Post('validate')
  validate(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: ValidateEnvTextInput,
  ) {
    return this.service.validateEnvText(projectId, req.session.user!.id, body);
  }

  @Delete(':metadataId')
  remove(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('metadataId') metadataId: string,
  ) {
    return this.service.deleteEnvMetadata(
      projectId,
      metadataId,
      req.session.user!.id,
    );
  }
}
