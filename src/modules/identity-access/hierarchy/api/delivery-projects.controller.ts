import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CreateRepositoryDto } from './dto/create-repository.dto';
import { DeleteDeliveryProjectDto } from './dto/delete-delivery-project.dto';
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

  /**
   * Deletes this Project (delivery project) together with every repository
   * inside it. Destructive and irreversible — throttled tighter than the app
   * default, matching DELETE /projects/:id.
   */
  @Delete(':deliveryProjectId')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  deleteDeliveryProject(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Body() body: DeleteDeliveryProjectDto,
  ) {
    return this.deliveryProjectsService.deleteDeliveryProject(
      deliveryProjectId,
      this.requireUserId(req),
      body,
      req.session.githubAccessToken,
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
