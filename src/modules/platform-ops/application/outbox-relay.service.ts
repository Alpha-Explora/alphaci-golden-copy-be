import { Injectable, type OnModuleInit } from '@nestjs/common';

import {
  OutboxRepository,
  type PendingOutboxEvent,
  type OutboxProcessingOptions,
  resolveOutboxProcessingTiming,
} from '#kernel/events/outbox.repository';
import {
  OutboxDispatcher,
  type OutboxTopicHandler,
} from '#kernel/events/outbox-dispatcher';
import { OUTBOX_TOPICS } from '#kernel/events/outbox-topics';
import {
  decodePlatformEvent,
  PLATFORM_EVENT_TOPICS,
} from '#kernel/events/platform-event.registry';
import { AuditEventsService } from '../audit/application/audit-events.service';
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
      this.processingOptions(),
    );
  }

  /**
   * Deliver audit and notification events, and nothing else.
   *
   * This is the pass that runs on a timer, so it is deliberately narrower than
   * processPendingOnce. That one drains every topic the dispatcher knows,
   * including hierarchy grant/revoke, whose handlers add and remove people from
   * GitHub teams - which is why the manual script refuses to run until
   * HIERARCHY_GITHUB_SYNC_MODE is set explicitly. Nothing here can change
   * anyone's access: writing an audit row and a notification is all it does.
   *
   * Handled by this service directly rather than through the dispatcher, so a
   * claim can only ever reach the two handlers it was filtered for.
   */
  async processPlatformEventsOnce(limit = 50): Promise<number> {
    return this.outboxRepository.processPending(
      (event) => this.handle(event),
      limit,
      this.topics,
      this.processingOptions(),
    );
  }

  /**
   * Deliver hierarchy grant/revoke jobs, and nothing else.
   *
   * These handlers add and remove people from GitHub teams, so the timer only
   * calls this when HIERARCHY_GITHUB_SYNC_MODE=live (see OutboxRelayWorker).
   * The claim uses the same lease + SKIP LOCKED as every other pass, so this
   * and the `alphaci-outbox-relay` cron can run together without delivering a
   * job twice. Only topics whose handler is registered are claimed.
   */
  async processHierarchyEventsOnce(limit = 50): Promise<number> {
    const registered = new Set(this.dispatcher.topics());
    const topics = [
      OUTBOX_TOPICS.hierarchyAssignmentGrant,
      OUTBOX_TOPICS.hierarchyAssignmentRevoke,
    ].filter((topic) => registered.has(topic));
    if (topics.length === 0) {
      return 0;
    }
    return this.outboxRepository.processPending(
      (event) => this.dispatcher.dispatch(event),
      limit,
      topics,
      this.processingOptions(),
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

  private processingOptions(): OutboxProcessingOptions {
    const maxAttempts = positiveIntegerFromEnv('OUTBOX_MAX_ATTEMPTS');
    const retryDelaySeconds = positiveIntegerFromEnv(
      'OUTBOX_RETRY_DELAY_SECONDS',
    );
    const leaseSeconds = positiveIntegerFromEnv('OUTBOX_LEASE_SECONDS');
    const handlerTimeoutMs = positiveIntegerFromEnv(
      'OUTBOX_HANDLER_TIMEOUT_MS',
    );
    const timing = resolveOutboxProcessingTiming({
      leaseSeconds,
      handlerTimeoutMs,
    });
    return {
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(retryDelaySeconds === undefined ? {} : { retryDelaySeconds }),
      ...(leaseSeconds === undefined
        ? {}
        : { leaseSeconds: timing.leaseSeconds }),
      ...(handlerTimeoutMs === undefined
        ? {}
        : { handlerTimeoutMs: timing.handlerTimeoutMs }),
    };
  }
}

function positiveIntegerFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
