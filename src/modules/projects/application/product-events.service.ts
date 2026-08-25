import { Injectable } from '@nestjs/common';

import { AuditEventsService } from '../../audit/index.js';
import { NotificationEventsService } from '../../notifications/index.js';

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
    private readonly auditEventsService: AuditEventsService | undefined,
    private readonly notificationEventsService:
      NotificationEventsService | undefined,
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
