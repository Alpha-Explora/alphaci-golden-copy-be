import {
  Controller,
  Get,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { ProjectFoldersService } from '../application/project-folders.service';

@Controller('groups/:groupId/project-folders')
@UseGuards(SessionAuthGuard)
export class ProjectFoldersController {
  constructor(private readonly projectFoldersService: ProjectFoldersService) {}

  @Get()
  listProjectFolders(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.projectFoldersService.listProjectFolders(
      groupId,
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
