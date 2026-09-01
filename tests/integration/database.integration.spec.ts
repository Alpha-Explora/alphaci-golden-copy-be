import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';

import { postgresSslConfig } from '../../src/kernel/db/postgres-ssl.config.js';
import { OutboxRepository } from '../../src/kernel/events/outbox.repository';

const dbUrl = process.env['SUPABASE_DB_URL'];
const describeDatabase = dbUrl ? describe : describe.skip;

describeDatabase('Postgres schema integration', () => {
  it('can reach Postgres and exposes the active platform outbox contract', async () => {
    const client = new Client({
      connectionString: dbUrl,
      ssl: postgresSslConfig(dbUrl!, process.env['SUPABASE_DB_CA_CERT']),
    });
    await client.connect();

    try {
      const result = await client.query<{
        column_name: string;
        is_nullable: 'YES' | 'NO';
      }>(
        `
          SELECT column_name, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'platform'
            AND table_name = 'outbox_events'
          ORDER BY ordinal_position;
        `,
      );
      const columns = new Map(
        result.rows.map((row) => [row.column_name, row.is_nullable]),
      );

      expect([...columns.keys()]).toEqual(
        expect.arrayContaining([
          'topic',
          'status',
          'attempts',
          'available_at',
          'published_at',
          'last_error',
          'quarantined_at',
          'lease_token',
          'lease_expires_at',
        ]),
      );
      expect(columns.has('processed_at')).toBe(false);
      expect(columns.get('available_at')).toBe('YES');

      const indexes = await client.query<{ indexname: string }>(
        `
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'platform'
            AND tablename = 'outbox_events';
        `,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'idx_platform_outbox_pending_available',
          'idx_platform_outbox_quarantined',
        ]),
      );
    } finally {
      await client.end();
    }
  }, 30_000);

  it('supports retry, quarantine, acknowledgement, and rollback on one transaction', async () => {
    const client = new Client({
      connectionString: dbUrl,
      ssl: postgresSslConfig(dbUrl!, process.env['SUPABASE_DB_CA_CERT']),
    });
    await client.connect();

    try {
      await client.query('BEGIN');
      const aggregateId = `architecture-test-${Date.now()}`;
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO platform.outbox_events (
            topic, aggregate_type, aggregate_id, payload, status
          )
          VALUES ($1, $2, $3, $4::jsonb, 'pending')
          RETURNING id;
        `,
        [
          'platform.audit.recorded',
          'architecture_test',
          aggregateId,
          JSON.stringify({ eventCode: 'architecture.test' }),
        ],
      );
      const id = inserted.rows[0]?.id;
      expect(id).toBeTruthy();

      const retry = await client.query<{
        attempts: number;
        status: string;
        last_error: string | null;
      }>(
        `
          UPDATE platform.outbox_events
          SET attempts = 1,
              available_at = NOW() + INTERVAL '60 seconds',
              last_error = 'temporary test failure',
              updated_at = NOW()
          WHERE id = $1
          RETURNING attempts, status, last_error;
        `,
        [id],
      );
      expect(retry.rows[0]).toEqual({
        attempts: 1,
        status: 'pending',
        last_error: 'temporary test failure',
      });

      const quarantined = await client.query<{
        status: string;
        available_at: string | null;
        last_error: string | null;
        quarantined_at: string | null;
      }>(
        `
          UPDATE platform.outbox_events
          SET status = 'quarantined',
              available_at = NULL,
              last_error = 'terminal test failure',
              quarantined_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
          RETURNING status, available_at, last_error, quarantined_at;
        `,
        [id],
      );
      expect(quarantined.rows[0]).toEqual({
        status: 'quarantined',
        available_at: null,
        last_error: 'terminal test failure',
        quarantined_at: expect.anything(),
      });

      const published = await client.query<{ published_at: string | null }>(
        `
          INSERT INTO platform.outbox_events (
            topic, aggregate_type, aggregate_id, payload, status,
            published_at
          )
          VALUES ($1, $2, $3, $4::jsonb, 'published', NOW())
          RETURNING published_at;
        `,
        [
          'platform.audit.recorded',
          'architecture_test',
          `${aggregateId}-published`,
          JSON.stringify({ eventCode: 'architecture.test' }),
        ],
      );
      expect(published.rows[0]?.published_at).toBeTruthy();

      const inTransaction = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM platform.outbox_events
          WHERE aggregate_type = 'architecture_test'
            AND aggregate_id LIKE $1;
        `,
        [`${aggregateId}%`],
      );
      expect(inTransaction.rows[0]?.count).toBe('2');

      await client.query('ROLLBACK');

      const afterRollback = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM platform.outbox_events
          WHERE aggregate_type = 'architecture_test'
            AND aggregate_id LIKE $1;
        `,
        [`${aggregateId}%`],
      );
      expect(afterRollback.rows[0]?.count).toBe('0');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }, 30_000);

  it('allows only one live relay lease and acknowledges with published_at', async () => {
    const pool = new Pool({
      connectionString: dbUrl,
      ssl: postgresSslConfig(dbUrl!, process.env['SUPABASE_DB_CA_CERT']),
      max: 3,
    });
    const databaseService = {
      query: (text: string, values: unknown[] = []) => pool.query(text, values),
      withTransaction: async <T>(
        fn: (client: PoolClient) => Promise<T>,
      ): Promise<T> => {
        const client = await pool.connect();
        await client.query('BEGIN');
        try {
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const repository = new OutboxRepository(databaseService as never);
    const aggregateId = `architecture-relay-${randomUUID()}`;
    let releaseFirstHandler!: () => void;
    const firstHandlerReleased = new Promise<void>((resolve) => {
      releaseFirstHandler = resolve;
    });
    let firstHandlerStarted!: () => void;
    const firstHandlerReady = new Promise<void>((resolve) => {
      firstHandlerStarted = resolve;
    });

    try {
      await pool.query(
        `
          INSERT INTO platform.outbox_events (
            topic, aggregate_type, aggregate_id, payload, status, available_at
          )
          VALUES ($1, $2, $3, $4::jsonb, 'pending', NOW());
        `,
        [
          'platform.audit.recorded',
          'architecture_relay_test',
          aggregateId,
          JSON.stringify({ eventCode: 'architecture.relay.test' }),
        ],
      );

      const firstRun = repository.processPending(
        async () => {
          firstHandlerStarted();
          await firstHandlerReleased;
        },
        1,
        ['platform.audit.recorded'],
        { leaseSeconds: 60, handlerTimeoutMs: 5_000 },
      );
      await firstHandlerReady;

      const secondHandler = jest.fn().mockResolvedValue(undefined);
      await expect(
        repository.processPending(
          secondHandler,
          1,
          ['platform.audit.recorded'],
          { leaseSeconds: 60, handlerTimeoutMs: 5_000 },
        ),
      ).resolves.toBe(0);
      expect(secondHandler).not.toHaveBeenCalled();

      releaseFirstHandler();
      await expect(firstRun).resolves.toBe(1);

      const acknowledged = await pool.query<{
        status: string;
        published_at: string | null;
        lease_token: string | null;
        lease_expires_at: string | null;
      }>(
        `
          SELECT status, published_at, lease_token, lease_expires_at
          FROM platform.outbox_events
          WHERE aggregate_id = $1;
        `,
        [aggregateId],
      );
      expect(acknowledged.rows[0]).toEqual({
        status: 'published',
        published_at: expect.anything(),
        lease_token: null,
        lease_expires_at: null,
      });
    } finally {
      await pool.query(
        'DELETE FROM platform.outbox_events WHERE aggregate_id = $1',
        [aggregateId],
      );
      await pool.end();
    }
  }, 30_000);
});
