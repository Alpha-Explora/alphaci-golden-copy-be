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
import { AddDeliveryProjectMemberDto } from './dto/add-delivery-project-member.dto';
import { CreateDeliveryProjectRepositoryDto } from './dto/create-delivery-project-repository.dto';
import { DeleteDeliveryProjectDto } from './dto/delete-delivery-project.dto';
import { UpdateDeliveryProjectDto } from './dto/update-delivery-project.dto';
import { RepositoriesService } from '../application/repositories.service';
import { DeliveryProjectMembersService } from '../application/delivery-project-members.service';
import { DeliveryProjectsService } from '../application/delivery-projects.service';

@Controller('delivery-projects')
@UseGuards(SessionAuthGuard)
export class DeliveryProjectsController {
  constructor(
    private readonly deliveryProjectsService: DeliveryProjectsService,
    private readonly repositoriesService: RepositoriesService,
    private readonly membersService: DeliveryProjectMembersService,
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
    @Body() body: CreateDeliveryProjectRepositoryDto,
  ) {
    return this.repositoriesService.createRepository(
      deliveryProjectId,
      this.requireUserId(req),
      {
        githubAccessToken: req.session.githubAccessToken ?? null,
        login: req.session.user?.login,
      },
      body,
    );
  }

  /** Active members (Developers and QA Team) of the Project. Lead/admin only. */
  @Get(':deliveryProjectId/members')
  listMembers(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    return this.membersService.listMembers(
      deliveryProjectId,
      this.requireUserId(req),
    );
  }

  /**
   * Adds a team member to the Project. A Developer gets GitHub Write on every
   * repository of the Project (and on ones added later); QA only joins inside
   * ALPHACI. Lead/admin only.
   */
  @Post(':deliveryProjectId/members')
  addMember(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Body() body: AddDeliveryProjectMemberDto,
  ) {
    return this.membersService.addMember(
      deliveryProjectId,
      this.requireUserId(req),
      body,
    );
  }

  /** Re-runs the Developers' grant fan-out (backfill after live sync is enabled). */
  @Post(':deliveryProjectId/members/sync')
  resyncMembers(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ) {
    return this.membersService.resyncDevelopers(
      deliveryProjectId,
      this.requireUserId(req),
    );
  }

  @Delete(':deliveryProjectId/members/:memberUserId')
  removeMember(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('memberUserId') memberUserId: string,
  ) {
    return this.membersService.removeMember(
      deliveryProjectId,
      this.requireUserId(req),
      memberUserId,
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
