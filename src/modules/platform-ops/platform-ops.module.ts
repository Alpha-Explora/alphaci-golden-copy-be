import { Module } from '@nestjs/common';

import { EventsModule } from '#kernel/events/events.module';
import { AuditModule } from './audit/audit.module';
import { FeedbackModule } from './feedback/feedback.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxRelayService } from './application/outbox-relay.service';

/** Aggregation/composition module for the platform-ops bounded context. */
@Module({
  imports: [EventsModule, AuditModule, NotificationsModule, FeedbackModule],
  providers: [OutboxRelayService],
  exports: [OutboxRelayService],
})
export class PlatformOpsModule {}
