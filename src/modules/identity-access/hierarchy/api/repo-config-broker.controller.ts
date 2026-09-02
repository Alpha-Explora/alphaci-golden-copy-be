import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { WriteConfigurationDto } from './dto/write-configuration.dto';
import { RepoConfigBrokerService } from '../application/repo-config-broker.service';

@Controller('repositories/:repositoryId/configuration')
@UseGuards(SessionAuthGuard)
export class RepoConfigBrokerController {
  constructor(private readonly service: RepoConfigBrokerService) {}

  @Get()
  listConfiguration(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.service.listConfiguration(
      repositoryId,
      this.requireUserId(req),
    );
  }

  @Put('variables/:variableName')
  writeVariable(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Param('variableName') variableName: string,
    @Body() body: WriteConfigurationDto,
  ) {
    return this.service.writeVariable(
      repositoryId,
      this.requireUserId(req),
      variableName,
      body.value,
      body.environmentScope,
    );
  }

  @Put('secrets/:secretName')
  writeSecret(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Param('secretName') secretName: string,
    @Body() body: WriteConfigurationDto,
  ) {
    return this.service.writeSecret(
      repositoryId,
      this.requireUserId(req),
      secretName,
      body.value,
      body.environmentScope,
    );
  }

  @Delete(':configurationType/:name')
  deleteConfiguration(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Param('configurationType') configurationType: 'variable' | 'secret',
    @Param('name') name: string,
  ) {
    return this.service.deleteConfiguration(
      repositoryId,
      this.requireUserId(req),
      configurationType,
      name,
    );
  }

  private requireUserId(req: Request): string {
    const user = req.session.user;
    const userId = user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}
