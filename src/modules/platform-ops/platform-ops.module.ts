import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { AuditModule } from './audit/audit.module';
import { FeedbackModule } from './feedback/feedback.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxRelayService } from './application/outbox-relay.service';
import { OutboxRelayWorker } from './application/outbox-relay.worker';
import { NotificationRelayWorker } from './application/notification-relay.worker';

/** Aggregation/composition module for the platform-ops bounded context. */
@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    AuditModule,
    NotificationsModule,
    FeedbackModule,
  ],
  providers: [OutboxRelayService, OutboxRelayWorker, NotificationRelayWorker],
  exports: [OutboxRelayService],
})
export class PlatformOpsModule {}
