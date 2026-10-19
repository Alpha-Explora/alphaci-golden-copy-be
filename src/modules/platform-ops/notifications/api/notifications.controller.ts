import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Sse,
  Optional,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { interval, map, merge, mergeMap, takeUntil, timer } from 'rxjs';
import { NotificationStreamService } from '../application/notification-stream.service';

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
  constructor(
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly streams?: NotificationStreamService,
  ) {}

  @Sse('stream')
  stream(@Req() req: Request) {
    const userId = this.requireUserId(req);
    if (!this.streams) throw new Error('Notification streaming is unavailable');
    const heartbeat = interval(15000).pipe(
      mergeMap(
        () =>
          new Promise<void>((resolve, reject) => {
            req.sessionStore.get(req.sessionID, (error, session) => {
              if (
                error ||
                !session ||
                (session.user?.id ?? session.userId) !== userId
              ) {
                reject(new UnauthorizedException('Session ended'));
              } else resolve();
            });
          }),
      ),
      map(() => ({ type: 'heartbeat', data: {} })),
    );
    // Reconnection re-runs capability/session guards, including session expiry.
    return merge(this.streams.open(userId), heartbeat).pipe(
      takeUntil(merge(timer(300000), this.streams.closed$)),
    );
  }

  @Get()
  list(@Req() req: Request) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.notificationsService
      .listForUser(userId)
      .then((notifications) => ({ ...notifications, userId }));
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
