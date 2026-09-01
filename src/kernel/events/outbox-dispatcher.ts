import { Injectable } from '@nestjs/common';

import type { PendingOutboxEvent } from './outbox.repository';
import { isRegisteredOutboxTopic } from './outbox-topics';

/**
 * A context-owned consumer of one or more serialisable outbox topics.
 *
 * Handlers register their topic ownership at module initialisation time.  The
 * registry is intentionally transport-neutral so the same contract can later
 * be hosted by a worker or a separately deployed service without moving
 * business code into the outbox repository.
 */
export interface OutboxTopicHandler {
  readonly topics: readonly string[];
  handle(event: PendingOutboxEvent): Promise<void>;
}

@Injectable()
export class OutboxDispatcher {
  private readonly handlers = new Map<string, OutboxTopicHandler>();

  register(handler: OutboxTopicHandler): void {
    for (const topic of handler.topics) {
      if (!topic) {
        throw new Error('Outbox handlers must register a non-empty topic');
      }
      if (!isRegisteredOutboxTopic(topic)) {
        throw new Error(`Outbox topic '${topic}' is not in the topic registry`);
      }
      if (this.handlers.has(topic)) {
        throw new Error(`Outbox topic '${topic}' already has a handler`);
      }
      this.handlers.set(topic, handler);
    }
  }

  topics(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async dispatch(event: PendingOutboxEvent): Promise<void> {
    const handler = this.handlers.get(event.topic);
    if (!handler) {
      throw new Error(`No outbox handler registered for '${event.topic}'`);
    }
    await handler.handle(event);
  }
}
