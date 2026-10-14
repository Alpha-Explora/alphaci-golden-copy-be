import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { ProjectEnvironmentsService } from '../application/project-environments.service';
import {
  AddProjectEnvironmentDto,
  RenameProjectEnvironmentDto,
} from './dto/project-environment.dto';

@Controller('projects/:projectId/environments')
@UseGuards(SessionAuthGuard)
export class ProjectEnvironmentsController {
  constructor(
    private readonly projectEnvironmentsService: ProjectEnvironmentsService,
  ) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.projectEnvironmentsService.list(
      projectId,
      this.sessionUserId(req),
    );
  }

  @Post()
  add(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: AddProjectEnvironmentDto,
  ) {
    return this.projectEnvironmentsService.add(
      projectId,
      this.sessionUserId(req),
      body,
    );
  }

  @Patch(':environmentId')
  rename(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('environmentId') environmentId: string,
    @Body() body: RenameProjectEnvironmentDto,
  ) {
    return this.projectEnvironmentsService.rename(
      projectId,
      environmentId,
      this.sessionUserId(req),
      body.displayName,
    );
  }

  private sessionUserId(req: Request): string {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) throw new UnauthorizedException('Authentication required');
    return userId;
  }
}
