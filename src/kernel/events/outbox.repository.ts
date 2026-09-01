import { randomUUID } from 'node:crypto';

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
  /** How long a claimed row remains owned by this relay, in seconds. */
  leaseSeconds?: number;
  /** Maximum time spent awaiting one handler, in milliseconds. */
  handlerTimeoutMs?: number;
}

const OUTBOX_TABLE = 'platform.outbox_events';
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 86_400;
export const DEFAULT_OUTBOX_LEASE_SECONDS = 300;
const MAX_LEASE_SECONDS = 86_400;
export const DEFAULT_OUTBOX_HANDLER_TIMEOUT_MS = 120_000;
const MAX_HANDLER_TIMEOUT_MS = 900_000;

export function resolveOutboxProcessingTiming(options: {
  leaseSeconds?: number | undefined;
  handlerTimeoutMs?: number | undefined;
}): { leaseSeconds: number; handlerTimeoutMs: number } {
  const leaseSeconds = boundedPositiveInteger(
    options.leaseSeconds,
    DEFAULT_OUTBOX_LEASE_SECONDS,
    MAX_LEASE_SECONDS,
  );
  const handlerTimeoutMs = boundedPositiveInteger(
    options.handlerTimeoutMs,
    DEFAULT_OUTBOX_HANDLER_TIMEOUT_MS,
    MAX_HANDLER_TIMEOUT_MS,
  );

  if (leaseSeconds * 1_000 <= handlerTimeoutMs) {
    throw new Error(
      'OUTBOX_LEASE_SECONDS must be greater than OUTBOX_HANDLER_TIMEOUT_MS',
    );
  }

  return { leaseSeconds, handlerTimeoutMs };
}

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
   * Claim and process pending rows with short database transactions.
   *
   * The claim transaction uses row-level locking and a lease, then commits
   * before any handler is invoked. This prevents external provider latency from
   * holding a database connection or a process-wide lock. A crashed
   * relay leaves its rows pending with an expired lease, so a later run can
   * reclaim them. This is at-least-once delivery, not exactly-once delivery;
   * downstream handlers must remain idempotent if a process dies after the
   * side effect and before the published update.
   */
  async processPending(
    handler: OutboxEventHandler,
    limit = 50,
    topics: readonly string[] = [],
    options: OutboxProcessingOptions = {},
  ): Promise<number> {
    const boundedLimit = boundedPositiveInteger(
      limit,
      DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
    );
    const maxAttempts = boundedPositiveInteger(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      100,
    );
    const retryDelaySeconds = boundedPositiveInteger(
      options.retryDelaySeconds,
      DEFAULT_RETRY_DELAY_SECONDS,
      MAX_RETRY_DELAY_SECONDS,
    );
    const { leaseSeconds, handlerTimeoutMs } =
      resolveOutboxProcessingTiming(options);
    const ownedTopics = [
      ...new Set(
        topics.filter(
          (topic): topic is OutboxTopic =>
            topic.trim().length > 0 && isRegisteredOutboxTopic(topic),
        ),
      ),
    ];

    // A single outbox table can contain events owned by more than one context.
    // A relay must pass its registered topic set explicitly; otherwise a newly
    // introduced topic could be acknowledged by the wrong process. Ignore
    // unknown topic strings here as a second fail-closed guard for callers
    // that construct a topic list outside OutboxDispatcher.
    if (ownedTopics.length === 0) {
      return 0;
    }

    let processed = 0;
    for (let index = 0; index < boundedLimit; index += 1) {
      // Claim one row at a time. Claiming a full batch at once would let the
      // last row's lease expire while earlier rows are waiting on external
      // handlers, allowing a second relay to replay work concurrently.
      const leaseToken = randomUUID();
      const row = await this.databaseService.withTransaction(async (client) => {
        const result = await client.query<OutboxRow>(
          `
            WITH candidates AS (
              SELECT id
              FROM ${OUTBOX_TABLE}
              WHERE status = 'pending'
                AND (available_at IS NULL OR available_at <= NOW())
                AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
                AND topic = ANY($2::text[])
              ORDER BY created_at ASC, id ASC
              LIMIT $1
              FOR UPDATE SKIP LOCKED
            )
            UPDATE ${OUTBOX_TABLE} AS events
            SET lease_token = $3,
                lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
                updated_at = NOW()
            FROM candidates
            WHERE events.id = candidates.id
            RETURNING events.id, events.topic, events.aggregate_type,
                      events.aggregate_id, events.payload, events.created_at,
                      events.attempts;
          `,
          [1, ownedTopics, leaseToken, leaseSeconds],
        );
        return result.rows[0] ?? null;
      });
      if (!row) {
        break;
      }

      const event = toPendingEvent(row);
      try {
        await this.runHandler(handler, event, handlerTimeoutMs);
      } catch (error) {
        await this.recordFailure(
          event,
          row,
          leaseToken,
          error,
          maxAttempts,
          retryDelaySeconds,
        );
        continue;
      }

      const marked = await this.markPublished(event.id, leaseToken);
      if (marked) {
        processed += 1;
      }
    }
    return processed;
  }

  private async runHandler(
    handler: OutboxEventHandler,
    event: PendingOutboxEvent,
    timeoutMs: number,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        handler(event),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Outbox handler timed out after ${timeoutMs}ms for ${event.id}`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async markPublished(
    eventId: string,
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        UPDATE ${OUTBOX_TABLE}
        SET status = 'published',
            published_at = NOW(),
            last_error = NULL,
            quarantined_at = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1 AND status = 'pending' AND lease_token = $2
        RETURNING id;
      `,
      [eventId, leaseToken],
    );
    if (!result.rows[0]) {
      this.logger.warn(
        `Outbox event ${eventId} was handled but its lease was no longer owned; it may be delivered again`,
      );
      return false;
    }
    return true;
  }

  private async recordFailure(
    event: PendingOutboxEvent,
    row: OutboxRow,
    leaseToken: string,
    error: unknown,
    maxAttempts: number,
    retryDelaySeconds: number,
  ): Promise<void> {
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
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1 AND status = 'pending' AND lease_token = $4
          RETURNING id;
        `
      : `
          UPDATE ${OUTBOX_TABLE}
          SET attempts = $2,
              available_at = NOW() + ($3 * INTERVAL '1 second'),
              last_error = $4,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1 AND status = 'pending' AND lease_token = $5
          RETURNING id;
        `;
    const retryParams = terminal
      ? [event.id, nextAttempts, failure, leaseToken]
      : [event.id, nextAttempts, retryDelaySeconds, failure, leaseToken];
    const result = await this.databaseService.query<{ id: string }>(
      retryQuery,
      retryParams,
    );
    if (!result.rows[0]) {
      this.logger.warn(
        `Outbox failure state for ${event.id} was not updated because its lease was no longer owned`,
      );
    }
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

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), maximum));
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
