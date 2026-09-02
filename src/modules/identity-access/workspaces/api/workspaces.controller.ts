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
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { AppConfig } from '#kernel/config/app.config';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import type { WorkspaceRole } from '../infrastructure/workspaces.repository';
import { WorkspacesService } from '../application/workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly configService: ConfigService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  @Get('me')
  @UseGuards(SessionAuthGuard)
  getMyWorkspaces(@Req() req: Request) {
    const userId = this.requireUserId(req);
    const config = this.configService.getOrThrow<AppConfig>('app');
    if (!config.workspaces.enabled) {
      return { enabled: false, items: [] };
    }

    return this.workspacesService.getMyWorkspaces(userId);
  }

  @Get(':workspaceId/members')
  @UseGuards(SessionAuthGuard)
  listMembers(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    return this.workspacesService.listMembers(
      workspaceId,
      this.requireUserId(req),
    );
  }

  @Post(':workspaceId/members')
  @UseGuards(SessionAuthGuard)
  addMember(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() body: { loginOrEmail: string; role: WorkspaceRole },
  ) {
    return this.workspacesService.addMember(
      workspaceId,
      this.requireUserId(req),
      body,
    );
  }

  @Patch(':workspaceId/members/:memberId')
  @UseGuards(SessionAuthGuard)
  updateMemberRole(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() body: { role: WorkspaceRole },
  ) {
    return this.workspacesService.updateMemberRole(
      workspaceId,
      this.requireUserId(req),
      memberId,
      body.role,
    );
  }

  @Delete(':workspaceId/members/:memberId')
  @UseGuards(SessionAuthGuard)
  removeMember(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.workspacesService.removeMember(
      workspaceId,
      this.requireUserId(req),
      memberId,
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
