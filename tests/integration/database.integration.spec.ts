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
      const result = await client.query<{ column_name: string }>(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'platform'
            AND table_name = 'outbox_events'
          ORDER BY ordinal_position;
        `,
      );
      const columns = result.rows.map((row) => row.column_name);

      expect(columns).toEqual(
        expect.arrayContaining([
          'topic',
          'status',
          'attempts',
          'available_at',
          'published_at',
        ]),
      );
      expect(columns).not.toContain('processed_at');
    } finally {
      await client.end();
    }
  }, 30_000);

  it('couples an outbox insert and published acknowledgement to one transaction', async () => {
    const client = new Client({
      connectionString: dbUrl,
      ssl: postgresSslConfig(dbUrl!, process.env['SUPABASE_DB_CA_CERT']),
    });
    await client.connect();

    try {
      await client.query('BEGIN');
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
          `rollback-${Date.now()}`,
          JSON.stringify({ eventCode: 'architecture.test' }),
        ],
      );
      const id = inserted.rows[0]?.id;
      expect(id).toBeTruthy();

      const published = await client.query<{ published_at: string | null }>(
        `
          UPDATE platform.outbox_events
          SET status = 'published', published_at = NOW(), updated_at = NOW()
          WHERE id = $1
          RETURNING published_at;
        `,
        [id],
      );
      expect(published.rows[0]?.published_at).toBeTruthy();
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }, 30_000);
});
