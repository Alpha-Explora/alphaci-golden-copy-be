import { Injectable, Logger } from '@nestjs/common';

import {
  OutboxRepository,
  type PendingOutboxEvent,
} from '#kernel/events/outbox.repository';
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
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly auditEventsService: AuditEventsService,
    private readonly notificationEventsService: NotificationEventsService,
  ) {}

  async processPendingOnce(limit = 50): Promise<number> {
    return this.outboxRepository.processPending(
      (event) => this.dispatch(event),
      limit,
    );
  }

  private async dispatch(event: PendingOutboxEvent): Promise<void> {
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
        this.logger.warn(`No platform outbox handler for '${event.topic}'`);
    }
  }
}
