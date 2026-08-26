import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import { OutboxRepository } from '#kernel/events/outbox.repository';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from './platform-event-publisher';

/** Technical outbox adapter shared by modules that publish integration work. */
@Module({
  imports: [DatabaseModule],
  providers: [
    OutboxRepository,
    AuditEventPublisher,
    NotificationEventPublisher,
  ],
  exports: [OutboxRepository, AuditEventPublisher, NotificationEventPublisher],
})
export class EventsModule {}
