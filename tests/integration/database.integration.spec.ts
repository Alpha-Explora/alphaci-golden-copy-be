import { Client } from 'pg';

import { postgresSslConfig } from '../../src/kernel/db/postgres-ssl.config.js';

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
});
