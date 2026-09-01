import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import { OutboxDispatcher } from '#kernel/events/outbox-dispatcher';
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
    OutboxDispatcher,
    AuditEventPublisher,
    NotificationEventPublisher,
  ],
  exports: [
    OutboxRepository,
    OutboxDispatcher,
    AuditEventPublisher,
    NotificationEventPublisher,
  ],
})
export class EventsModule {}
