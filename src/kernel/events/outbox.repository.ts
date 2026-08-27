import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import {
  isRegisteredOutboxTopic,
  type OutboxTopic,
} from './outbox-topics';

export interface OutboxEventInput {
  topic: OutboxTopic;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

export interface PendingOutboxEvent {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: string;
}

export type OutboxEventHandler = (event: PendingOutboxEvent) => Promise<void>;

const OUTBOX_RELAY_LOCK = 'alphaci_platform_outbox_relay';
const OUTBOX_TABLE = 'platform.outbox_events';

@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger(OutboxRepository.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Write an event on the caller's transaction. The business mutation and the
   * event row are committed or rolled back together.
   */
  async publishInTransaction(
    client: Pick<PoolClient, 'query'>,
    event: OutboxEventInput,
  ): Promise<void> {
    await this.insert(client, event);
  }

  /** Strict durable write for a caller that owns no transaction. */
  async publishDurably(event: OutboxEventInput): Promise<void> {
    await this.insert(
      this.databaseService as unknown as Pick<PoolClient, 'query'>,
      event,
    );
  }

  /**
   * Explicit best-effort seam for non-critical producers. Transactional
   * business transitions must use publishInTransaction() instead; this method
   * deliberately suppresses a queueing failure after the business mutation has
   * already committed.
   */
  async publishBestEffort(event: OutboxEventInput): Promise<void> {
    try {
      await this.publishDurably(event);
    } catch (error) {
      this.logger.warn(`Outbox write skipped: ${(error as Error).message}`);
    }
  }

  /**
   * Process pending rows under one PostgreSQL advisory lock.
   *
   * There is intentionally one owner for this table. The lock prevents two
   * web/cron instances from dispatching the same pending row concurrently;
   * rows remain pending when a handler fails and are retried on the next run.
   * This is at-least-once delivery, not an exactly-once claim: downstream
   * handlers must remain idempotent if a process dies after handling and before
   * the published update.
   */
  async processPending(
    handler: OutboxEventHandler,
    limit = 50,
    topics: readonly string[] = [],
  ): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));

    // A single outbox table can contain events owned by more than one context.
    // A relay must pass its registered topic set explicitly; otherwise a newly
    // introduced topic could be acknowledged by the wrong process.
    if (topics.length === 0) {
      return 0;
    }

    return this.databaseService.withClient(async (client) => {
      const lockResult = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [OUTBOX_RELAY_LOCK],
      );
      if (!lockResult.rows[0]?.locked) {
        this.logger.debug('Outbox relay lock is held by another process');
        return 0;
      }

      try {
        const result = await client.query<OutboxRow>(
          `
            SELECT id, topic, aggregate_type, aggregate_id, payload, created_at, attempts
            FROM ${OUTBOX_TABLE}
            WHERE status = 'pending'
              AND (available_at IS NULL OR available_at <= NOW())
              AND topic = ANY($2::text[])
            ORDER BY created_at ASC, id ASC
            LIMIT $1;
          `,
          [boundedLimit, [...topics]],
        );

        let processed = 0;
        for (const row of result.rows) {
          const event = toPendingEvent(row);
          try {
            await handler(event);
            const marked = await client.query<{ id: string }>(
              `
                UPDATE ${OUTBOX_TABLE}
                SET status = 'published', published_at = NOW(), updated_at = NOW()
                WHERE id = $1 AND status = 'pending'
                RETURNING id;
              `,
              [event.id],
            );
            if (marked.rows[0]) {
              processed += 1;
            }
          } catch (error) {
            this.logger.warn(
              `Outbox event ${event.id} (${event.topic}) was not processed: ${String(error)}`,
            );
            await client
              .query(
                `
                  UPDATE ${OUTBOX_TABLE}
                  SET attempts = attempts + 1,
                      available_at = NOW() + INTERVAL '1 minute',
                      updated_at = NOW()
                  WHERE id = $1 AND status = 'pending';
                `,
                [event.id],
              )
              .catch((retryError: unknown) => {
                this.logger.warn(
                  `Outbox retry schedule failed for ${event.id}: ${String(retryError)}`,
                );
              });
          }
        }
        return processed;
      } finally {
        await client
          .query('SELECT pg_advisory_unlock(hashtext($1))', [OUTBOX_RELAY_LOCK])
          .catch((error: unknown) => {
            this.logger.warn(
              `Outbox relay lock release failed: ${String(error)}`,
            );
          });
      }
    });
  }

  private async insert(
    executor: Pick<PoolClient, 'query'>,
    event: OutboxEventInput,
  ): Promise<void> {
    if (!isRegisteredOutboxTopic(event.topic)) {
      throw new Error(`Unsupported outbox topic '${event.topic}'`);
    }
    await executor.query(
      `
        INSERT INTO ${OUTBOX_TABLE} (
          topic,
          aggregate_type,
          aggregate_id,
          payload,
          status
        )
        VALUES ($1, $2, $3, $4::jsonb, 'pending');
      `,
      [
        event.topic,
        event.aggregateType,
        event.aggregateId,
        JSON.stringify(event.payload ?? {}),
      ],
    );
  }
}

interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: string | Date;
  attempts: number;
}

function toPendingEvent(row: OutboxRow): PendingOutboxEvent {
  return {
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
  };
}
