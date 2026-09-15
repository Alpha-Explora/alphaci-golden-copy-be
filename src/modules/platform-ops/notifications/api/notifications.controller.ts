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

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { NotificationsService } from '../application/notifications.service';

@Controller('notifications')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('platform.notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@Req() req: Request) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.notificationsService.listForUser(userId);
  }

  @Post(':id/read')
  markRead(@Req() req: Request, @Param('id') id: string) {
    const userId = this.requireUserId(req);
    return this.notificationsService.markRead(userId, id);
  }

  @Get('preferences')
  getPreferences(@Req() req: Request) {
    return this.notificationsService.getPreferences(this.requireUserId(req));
  }

  @Patch('preferences')
  updatePreferences(
    @Req() req: Request,
    @Body() body: { inAppEnabled?: boolean; emailEnabled?: boolean },
  ) {
    return this.notificationsService.updatePreferences(
      this.requireUserId(req),
      body,
    );
  }

  private requireUserId(req: Request): string {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}
