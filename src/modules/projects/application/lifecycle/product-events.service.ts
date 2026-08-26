import { Injectable } from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { NotificationEventPublisher } from '#kernel/events/platform-event-publisher.js';

type AuditEventSink = Pick<AuditEventPublisher, 'recordProjectEvent'>;
type NotificationEventSink = Pick<NotificationEventPublisher, 'record'>;

/**
 * Fan-out for project lifecycle events: every notable action is recorded
 * once in the audit log and once in the notification stream.
 *
 * Extracted verbatim from ProjectsService. Both sinks are optional so the
 * service degrades silently when those modules are not wired (tests).
 */
@Injectable()
export class ProductEventsService {
  constructor(
    private readonly auditEventsService: AuditEventSink | undefined,
    private readonly notificationEventsService:
      | NotificationEventSink
      | undefined,
  ) {}

  async record(input: {
    userId: string;
    projectId: string | null;
    eventCode: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      actorUserId: input.userId,
      projectId: input.projectId,
      eventCode: input.eventCode,
      message: input.title,
      metadata: input.metadata,
    });
    await this.notificationEventsService?.record({
      userId: input.userId,
      projectId: input.projectId,
      eventCode: input.eventCode,
      title: input.title,
      body: input.body,
    });
  }
}
