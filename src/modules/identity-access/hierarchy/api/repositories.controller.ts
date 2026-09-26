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
import { MoveRepositoryDto } from './dto/move-repository.dto';
import { UpdateRepositoryDto } from './dto/update-repository.dto';
import { RepositoriesService } from '../application/repositories.service';

@Controller('repositories')
@UseGuards(SessionAuthGuard)
export class RepositoriesController {
  constructor(private readonly repositoriesService: RepositoriesService) {}

  @Get(':repositoryId')
  getRepository(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.repositoriesService.getRepository(
      repositoryId,
      this.requireUserId(req),
    );
  }

  @Patch(':repositoryId')
  updateRepository(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Body() body: UpdateRepositoryDto,
  ) {
    return this.repositoriesService.updateRepository(
      repositoryId,
      this.requireUserId(req),
      body,
    );
  }

  @Post(':repositoryId/move')
  moveRepository(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Body() body: MoveRepositoryDto,
  ) {
    return this.repositoriesService.moveRepository(
      repositoryId,
      this.requireUserId(req),
      body.deliveryProjectId,
    );
  }

  @Post(':repositoryId/archive')
  archiveRepository(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.repositoriesService.archiveRepository(
      repositoryId,
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
