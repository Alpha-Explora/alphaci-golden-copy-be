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
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { CreateDeliveryProjectDto } from './dto/create-delivery-project.dto';
import { CreateEmptyProjectDto } from './dto/create-empty-project.dto';
import { DeliveryProjectsService } from '../application/delivery-projects.service';
import { SystemsService } from '../application/systems.service';

@Controller()
@UseGuards(SessionAuthGuard)
export class SystemsController {
  constructor(
    private readonly systemsService: SystemsService,
    private readonly deliveryProjectsService: DeliveryProjectsService,
  ) {}

  @Post('groups/:groupId/systems')
  createSystem(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Body() body: CreateSystemDto,
  ) {
    return this.systemsService.createSystem(
      groupId,
      this.requireUserId(req),
      req.session.githubAccessToken,
      body,
    );
  }

  @Get('groups/:groupId/systems')
  listSystems(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.systemsService.listSystems(groupId, this.requireUserId(req));
  }

  /**
   * "Project folder" with no repository — Team lead/Admin (or platform
   * admin), same gate as createSystem. Returns the DeliveryProject shape
   * (the API-facing "Project"), not the System.
   */
  @Post('groups/:groupId/projects')
  createEmptyProject(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Body() body: CreateEmptyProjectDto,
  ) {
    return this.systemsService.createEmptyProject(
      groupId,
      this.requireUserId(req),
      body,
    );
  }

  @Get('systems/:systemId')
  getSystem(@Req() req: Request, @Param('systemId') systemId: string) {
    return this.systemsService.getSystem(systemId, this.requireUserId(req));
  }

  @Patch('systems/:systemId')
  updateSystem(
    @Req() req: Request,
    @Param('systemId') systemId: string,
    @Body() body: UpdateSystemDto,
  ) {
    return this.systemsService.updateSystem(
      systemId,
      this.requireUserId(req),
      body,
    );
  }

  @Post('systems/:systemId/archive')
  archiveSystem(@Req() req: Request, @Param('systemId') systemId: string) {
    return this.systemsService.archiveSystem(systemId, this.requireUserId(req));
  }

  @Post('systems/:systemId/delivery-projects')
  createDeliveryProject(
    @Req() req: Request,
    @Param('systemId') systemId: string,
    @Body() body: CreateDeliveryProjectDto,
  ) {
    return this.deliveryProjectsService.createDeliveryProject(
      systemId,
      this.requireUserId(req),
      body,
    );
  }

  @Get('systems/:systemId/delivery-projects')
  listDeliveryProjects(
    @Req() req: Request,
    @Param('systemId') systemId: string,
  ) {
    return this.deliveryProjectsService.listDeliveryProjects(
      systemId,
      this.requireUserId(req),
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
