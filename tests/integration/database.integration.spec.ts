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
});
