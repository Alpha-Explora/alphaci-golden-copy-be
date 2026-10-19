import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { NotificationsController } from './api/notifications.controller';
import { NotificationEventsService } from './application/notification-events.service';
import { NotificationsRepository } from './infrastructure/notifications.repository';
import { NotificationsService } from './application/notifications.service';
import { NotificationStreamService } from './application/notification-stream.service';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    NotificationStreamService,
    NotificationEventsService,
    SessionAuthGuard,
  ],
  exports: [NotificationsService, NotificationEventsService],
})
export class NotificationsModule {}
