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
import { ProjectFolderService } from '../application/folder/project-folder.service';

/**
 * GET /api/v1/projects/:projectId/folder
 * The sibling repositories of the Project (delivery project) a project is
 * filed under, for the project page's repository switcher. Read-only.
 */
@Controller('projects/:projectId/folder')
@UseGuards(SessionAuthGuard)
export class ProjectFolderController {
  constructor(private readonly projectFolderService: ProjectFolderService) {}

  @Get()
  getProjectFolder(@Req() req: Request, @Param('projectId') projectId: string) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.projectFolderService.getProjectFolder(projectId, userId);
  }
}
