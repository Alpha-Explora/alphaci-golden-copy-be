import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';

import {
  listUpMigrations,
  MigrationChecksumMismatchError,
  type SqlClient,
  resolveSelfhostAssetPaths,
  runSelfhostMigrations,
} from '../../src/scripts/selfhost-migrations';

/**
 * Runs the self-hosted runner against real PostgreSQL: a fresh database, two
 * concurrent starts, a no-op rerun, and a tampered checksum.
 *
 * Runs only when SELFHOST_MIGRATION_TEST_ADMIN_URL is set. That URL must be an
 * admin connection to a throwaway server, because the spec creates and drops its
 * own database. Never point it at a SaaS or shared database.
 */
const adminUrl = process.env['SELFHOST_MIGRATION_TEST_ADMIN_URL'];
const describeDatabase = adminUrl ? describe : describe.skip;

const assets = resolveSelfhostAssetPaths(resolve(__dirname, '..', '..'));
const expectedTotal = listUpMigrations(assets.migrationsDir).length;

function urlFor(database: string): string {
  const url = new URL(adminUrl ?? 'postgresql://localhost/postgres');
  url.pathname = `/${database}`;
  return url.toString();
}

function clientFor(connectionString: string): SqlClient & {
  close: () => Promise<void>;
  connect: () => Promise<void>;
} {
  const client = new Client({ connectionString });
  return {
    connect: async () => {
      await client.connect();
    },
    close: () => client.end(),
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await client.query<Row>(
        text,
        values ? [...values] : undefined,
      );
      return { rows: result.rows };
    },
  };
}

async function runWith(connectionString: string): Promise<{ applied: number }> {
  const db = clientFor(connectionString);
  await db.connect();
  try {
    const summary = await runSelfhostMigrations(db, {
      migrationsDir: assets.migrationsDir,
      bootstrapSqlPath: assets.bootstrapSqlPath,
      log: () => undefined,
      warn: () => undefined,
    });
    return { applied: summary.applied.length };
  } finally {
    await db.close();
  }
}

describeDatabase('self-hosted migration runner', () => {
  const database = `selfhost_it_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Client({ connectionString: adminUrl });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('applies every migration from an empty database, with two starts racing', async () => {
    const [first, second] = await Promise.all([
      runWith(urlFor(database)),
      runWith(urlFor(database)),
    ]);

    expect(first.applied + second.applied).toBe(expectedTotal);

    const check = new Client({ connectionString: urlFor(database) });
    await check.connect();
    try {
      const ledger = await check.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM public.schema_migrations',
      );
      expect(Number(ledger.rows[0]?.n)).toBe(expectedTotal);

      const roles = await check.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname",
      );
      expect(roles.rows.map((row) => row.rolname)).toEqual([
        'anon',
        'authenticated',
      ]);

      const storage = await check.query<{ regclass: string | null }>(
        "SELECT to_regclass('storage.buckets')::text AS regclass",
      );
      expect(storage.rows[0]?.regclass).toBeNull();
    } finally {
      await check.end();
    }
  }, 300_000);

  it('is a no-op when rerun on a migrated database', async () => {
    await expect(runWith(urlFor(database))).resolves.toEqual({ applied: 0 });
  }, 120_000);

  it('refuses to start when a recorded checksum no longer matches the file', async () => {
    const tamper = new Client({ connectionString: urlFor(database) });
    await tamper.connect();
    try {
      await tamper.query(
        "UPDATE public.schema_migrations SET checksum = 'tampered' WHERE version = (SELECT version FROM public.schema_migrations ORDER BY version LIMIT 1)",
      );
    } finally {
      await tamper.end();
    }

    await expect(runWith(urlFor(database))).rejects.toBeInstanceOf(
      MigrationChecksumMismatchError,
    );

    const restore = new Client({ connectionString: urlFor(database) });
    await restore.connect();
    try {
      const first = listUpMigrations(assets.migrationsDir)[0];
      await restore.query(
        'UPDATE public.schema_migrations SET checksum = $1 WHERE version = $2',
        [first?.checksum, first?.version],
      );
    } finally {
      await restore.end();
    }
  }, 120_000);
});
