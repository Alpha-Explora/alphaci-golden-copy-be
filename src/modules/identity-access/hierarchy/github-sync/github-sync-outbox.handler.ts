import { Injectable, type OnModuleInit } from '@nestjs/common';

import {
  OutboxDispatcher,
  type OutboxTopicHandler,
} from '#kernel/events/outbox-dispatcher';
import type { PendingOutboxEvent } from '#kernel/events/outbox.repository';
import {
  HIERARCHY_OUTBOX_TOPICS,
  type HierarchyOutboxTopic,
} from '../hierarchy.types';
import {
  GithubSyncService,
  type HierarchyOutboxJobPayload,
} from './github-sync.service';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePayload(value: unknown): HierarchyOutboxJobPayload {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!isRecord(parsed)) {
    throw new Error('Hierarchy outbox payload must be a JSON object');
  }

  for (const field of ['assignmentId', 'actingUserId']) {
    if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
      throw new Error(`Hierarchy outbox field '${field}' must be a string`);
    }
  }

  const assignmentId = parsed.assignmentId;
  const actingUserId = parsed.actingUserId;
  if (typeof assignmentId !== 'string' || typeof actingUserId !== 'string') {
    throw new Error('Hierarchy outbox payload failed validation');
  }

  return { assignmentId, actingUserId };
}

/** Registers hierarchy's GitHub sync topics with the one application relay. */
@Injectable()
export class GithubSyncOutboxHandler
  implements OnModuleInit, OutboxTopicHandler
{
  readonly topics: readonly HierarchyOutboxTopic[] = [
    HIERARCHY_OUTBOX_TOPICS.grant,
    HIERARCHY_OUTBOX_TOPICS.revoke,
  ];

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly githubSyncService: GithubSyncService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: PendingOutboxEvent): Promise<void> {
    await this.githubSyncService.processJob(
      event.topic,
      decodePayload(event.payload),
    );
  }
}
