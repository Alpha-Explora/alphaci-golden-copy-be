import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { DatabaseModule } from '../../kernel/db/database.module';
import { NotificationsController } from './api/notifications.controller';
import { NotificationEventsService } from './domain/notification-events.service';
import { NotificationsRepository } from './infra/notifications.repository';
import { NotificationsService } from './domain/notifications.service';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    NotificationEventsService,
    SessionAuthGuard,
  ],
  exports: [NotificationsService, NotificationEventsService],
})
export class NotificationsModule {}
