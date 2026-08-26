import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { AssignmentsRepository } from './assignments/assignments.repository';
import { GroupsRepository } from './groups/groups.repository';

@Controller('me')
@UseGuards(SessionAuthGuard)
export class MeController {
  constructor(
    private readonly groupsRepository: GroupsRepository,
    private readonly assignmentsRepository: AssignmentsRepository,
  ) {}

  /**
   * Developer dashboard "My groups" (plan §2.6). Wrapped in { items } — the
   * /me/* and activity endpoints return objects, not bare arrays (UI_LAYOUTS.md
   * §6.4), matching how GroupActivityService already wraps its own response.
   */
  @Get('groups')
  async getMyGroups(@Req() req: Request) {
    const items = await this.groupsRepository.listForUser(
      this.requireUserId(req),
    );
    return { items };
  }

  /** Developer dashboard "My assigned repositories" + "Repository access status" (plan §2.6). */
  @Get('assigned-repositories')
  async getMyAssignedRepositories(@Req() req: Request) {
    const items =
      await this.assignmentsRepository.listActiveOrPendingForUserWithRepository(
        this.requireUserId(req),
      );
    return { items };
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
