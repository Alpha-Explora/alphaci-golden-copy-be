import { Injectable, Logger } from '@nestjs/common';

import { OutboxRepository } from './outbox.repository';
import {
  PLATFORM_EVENT_TOPICS,
  type AuditRecordedEventPayload,
  type NotificationRequestedEventPayload,
} from './platform-event.registry';

function aggregateIdFor(
  input: AuditRecordedEventPayload | NotificationRequestedEventPayload,
): string {
  return (
    ('projectId' in input ? input.projectId : undefined) ??
    ('workspaceId' in input ? input.workspaceId : undefined) ??
    ('actorUserId' in input ? input.actorUserId : undefined) ??
    ('userId' in input ? input.userId : undefined) ??
    'platform'
  );
}

/** Outbox-only audit seam used by contexts that emit non-critical audit data. */
@Injectable()
export class AuditEventPublisher {
  private readonly logger = new Logger(AuditEventPublisher.name);

  constructor(private readonly outboxRepository: OutboxRepository) {}

  async recordProjectEvent(input: AuditRecordedEventPayload): Promise<void> {
    try {
      await this.outboxRepository.publishLater({
        topic: PLATFORM_EVENT_TOPICS.auditRecorded,
        aggregateType: 'audit_event',
        aggregateId: aggregateIdFor(input),
        payload: { ...input, metadata: input.metadata ?? {} },
      });
    } catch (error) {
      // Preserve the pre-outbox fire-and-forget behaviour: observability must
      // not turn an already-committed business mutation into a 500.
      this.logger.warn(
        `Audit event '${input.eventCode}' was not queued: ${String(error)}`,
      );
    }
  }
}

/** Outbox-only notification seam used by contexts that request in-app mail. */
@Injectable()
export class NotificationEventPublisher {
  private readonly logger = new Logger(NotificationEventPublisher.name);

  constructor(private readonly outboxRepository: OutboxRepository) {}

  async record(input: NotificationRequestedEventPayload): Promise<void> {
    try {
      await this.outboxRepository.publishLater({
        topic: PLATFORM_EVENT_TOPICS.notificationRequested,
        aggregateType: 'notification',
        aggregateId: aggregateIdFor(input),
        payload: input,
      });
    } catch (error) {
      this.logger.warn(
        `Notification '${input.eventCode}' was not queued: ${String(error)}`,
      );
    }
  }
}
