import {
  Controller,
  Get,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { WorkspacesService } from '../application/workspaces.service';

@Controller('workspaces')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('identity.workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get('me')
  getMyWorkspaces(@Req() req: Request) {
    const userId = this.requireUserId(req);
    return this.workspacesService.getMyWorkspaces(userId);
  }

  @Get(':workspaceId/members')
  listMembers(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    return this.workspacesService.listMembers(
      workspaceId,
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
