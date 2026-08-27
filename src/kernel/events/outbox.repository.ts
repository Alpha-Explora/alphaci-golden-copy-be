import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import { isRegisteredOutboxTopic, type OutboxTopic } from './outbox-topics';

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

export interface OutboxProcessingOptions {
  /** Maximum number of handler failures before the row is quarantined. */
  maxAttempts?: number;
  /** Delay before a retry becomes eligible, in seconds. */
  retryDelaySeconds?: number;
}

const OUTBOX_RELAY_LOCK = 'alphaci_platform_outbox_relay';
const OUTBOX_TABLE = 'platform.outbox_events';
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 86_400;

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
      this.logger.warn(`Outbox write skipped: ${this.sanitizeError(error)}`);
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
    options: OutboxProcessingOptions = {},
  ): Promise<number> {
    const boundedLimit = this.boundedPositiveInteger(
      limit,
      DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
    );
    const maxAttempts = this.boundedPositiveInteger(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      100,
    );
    const retryDelaySeconds = this.boundedPositiveInteger(
      options.retryDelaySeconds,
      DEFAULT_RETRY_DELAY_SECONDS,
      MAX_RETRY_DELAY_SECONDS,
    );
    const ownedTopics = [...new Set(topics.filter((topic) => topic.trim()))];

    // A single outbox table can contain events owned by more than one context.
    // A relay must pass its registered topic set explicitly; otherwise a newly
    // introduced topic could be acknowledged by the wrong process.
    if (ownedTopics.length === 0) {
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
          [boundedLimit, ownedTopics],
        );

        let processed = 0;
        for (const row of result.rows) {
          const event = toPendingEvent(row);
          try {
            await handler(event);
            const marked = await client.query<{ id: string }>(
              `
                UPDATE ${OUTBOX_TABLE}
                SET status = 'published',
                    published_at = NOW(),
                    last_error = NULL,
                    quarantined_at = NULL,
                    updated_at = NOW()
                WHERE id = $1 AND status = 'pending'
                RETURNING id;
              `,
              [event.id],
            );
            if (marked.rows[0]) {
              processed += 1;
            }
          } catch (error) {
            const failure = this.sanitizeError(error);
            const nextAttempts = Math.max(0, row.attempts) + 1;
            this.logger.warn(
              `Outbox event ${event.id} (${event.topic}) was not processed: ${failure}`,
            );
            const terminal = nextAttempts >= maxAttempts;
            const retryQuery = terminal
              ? `
                  UPDATE ${OUTBOX_TABLE}
                  SET status = 'quarantined',
                      attempts = $2,
                      available_at = NULL,
                      last_error = $3,
                      quarantined_at = NOW(),
                      updated_at = NOW()
                  WHERE id = $1 AND status = 'pending';
                `
              : `
                  UPDATE ${OUTBOX_TABLE}
                  SET attempts = $2,
                      available_at = NOW() + ($3 * INTERVAL '1 second'),
                      last_error = $4,
                      updated_at = NOW()
                  WHERE id = $1 AND status = 'pending';
                `;
            const retryParams = terminal
              ? [event.id, nextAttempts, failure]
              : [event.id, nextAttempts, retryDelaySeconds, failure];
            try {
              await client.query(retryQuery, retryParams);
            } catch (retryError) {
              this.logger.warn(
                `Outbox retry schedule failed for ${event.id}: ${this.sanitizeError(retryError)}`,
              );
              // A successful handler failure must not be reported as a
              // successful relay run when its retry/quarantine state could
              // not be persisted. Propagate the database error so the
              // scheduler can alert and retry the whole run.
              throw retryError;
            }
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

  private boundedPositiveInteger(
    value: number | undefined,
    fallback: number,
    maximum: number,
  ): number {
    if (!Number.isFinite(value) || value === undefined) {
      return fallback;
    }
    return Math.max(1, Math.min(Math.floor(value), maximum));
  }

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1_000);
  }

  private async insert(
    executor: Pick<PoolClient, 'query'>,
    event: OutboxEventInput,
  ): Promise<void> {
    if (!isRegisteredOutboxTopic(event.topic)) {
      throw new Error(`Unsupported outbox topic '${String(event.topic)}'`);
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
