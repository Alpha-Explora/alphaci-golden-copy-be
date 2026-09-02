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
import { CreateRepositoryDto } from './dto/create-repository.dto';
import { UpdateDeliveryProjectDto } from './dto/update-delivery-project.dto';
import { RepositoriesService } from '../application/repositories.service';
import { DeliveryProjectsService } from '../application/delivery-projects.service';

@Controller('delivery-projects')
@UseGuards(SessionAuthGuard)
export class DeliveryProjectsController {
  constructor(
    private readonly deliveryProjectsService: DeliveryProjectsService,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  @Get(':deliveryProjectId')
  getDeliveryProject(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    return this.deliveryProjectsService.getDeliveryProject(
      deliveryProjectId,
      this.requireUserId(req),
    );
  }

  @Patch(':deliveryProjectId')
  updateDeliveryProject(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Body() body: UpdateDeliveryProjectDto,
  ) {
    return this.deliveryProjectsService.updateDeliveryProject(
      deliveryProjectId,
      this.requireUserId(req),
      body,
    );
  }

  @Post(':deliveryProjectId/archive')
  archiveDeliveryProject(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    return this.deliveryProjectsService.archiveDeliveryProject(
      deliveryProjectId,
      this.requireUserId(req),
    );
  }

  @Post(':deliveryProjectId/repositories')
  createRepository(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Body() body: CreateRepositoryDto,
  ) {
    return this.repositoriesService.createRepository(
      deliveryProjectId,
      this.requireUserId(req),
      req.session.githubAccessToken,
      body,
    );
  }

  @Get(':deliveryProjectId/repositories')
  listRepositories(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    return this.repositoriesService.listRepositories(
      deliveryProjectId,
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
