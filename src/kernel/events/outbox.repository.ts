import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

export interface OutboxEventInput {
  topic: string;
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

@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger(OutboxRepository.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async publishLater(event: OutboxEventInput): Promise<void> {
    try {
      await this.databaseService.query(
        `
          INSERT INTO outbox_events (
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
  ): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));

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
            SELECT id, topic, aggregate_type, aggregate_id, payload, created_at
            FROM outbox_events
            WHERE status = 'pending'
            ORDER BY created_at ASC, id ASC
            LIMIT $1;
          `,
          [boundedLimit],
        );

        let processed = 0;
        for (const row of result.rows) {
          const event = toPendingEvent(row);
          try {
            await handler(event);
            const marked = await client.query<{ id: string }>(
              `
                UPDATE outbox_events
                SET status = 'published', processed_at = NOW()
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
}

interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: string | Date;
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
