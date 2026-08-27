import { Injectable, type OnModuleInit } from '@nestjs/common';

import {
  OutboxRepository,
  type PendingOutboxEvent,
} from '#kernel/events/outbox.repository';
import {
  OutboxDispatcher,
  type OutboxTopicHandler,
} from '#kernel/events/outbox-dispatcher';
import {
  decodePlatformEvent,
  PLATFORM_EVENT_TOPICS,
} from '#kernel/events/platform-event.registry';
import { AuditEventsService } from '../audit/audit-events.service';
import { NotificationEventsService } from '../notifications/application/notification-events.service';

/**
 * The single in-process owner of platform outbox delivery.
 *
 * Producers depend only on the kernel event contract, while this consumer
 * owns audit/notification policy and storage. A future worker can replace
 * this class without changing producers.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OutboxTopicHandler {
  readonly topics = Object.values(PLATFORM_EVENT_TOPICS);

  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly dispatcher: OutboxDispatcher,
    private readonly auditEventsService: AuditEventsService,
    private readonly notificationEventsService: NotificationEventsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async processPendingOnce(limit = 50): Promise<number> {
    return this.outboxRepository.processPending(
      (event) => this.dispatcher.dispatch(event),
      limit,
      this.dispatcher.topics(),
    );
  }

  async handle(event: PendingOutboxEvent): Promise<void> {
    const decoded = decodePlatformEvent(event.topic, event.payload);

    switch (decoded.topic) {
      case PLATFORM_EVENT_TOPICS.auditRecorded:
        // recordProjectEvent retains the existing feature flag and
        // self-protecting audit semantics at the consumer boundary.
        await this.auditEventsService.recordProjectEvent(decoded.payload);
        return;
      case PLATFORM_EVENT_TOPICS.notificationRequested:
        await this.notificationEventsService.record(decoded.payload);
        return;
      default:
        // The dispatcher should make this unreachable. Keep the exhaustive
        // guard explicit so a new platform topic cannot be silently acked.
        throw new Error(`Unsupported platform event topic '${event.topic}'`);
    }
  }
}
