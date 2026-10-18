import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { Client, Pool, type PoolClient } from 'pg';

import type { DatabaseService } from '../../src/kernel/db/database.service';
import { PostgresQaAttachmentOrphanSweep } from '../../src/modules/projects/infrastructure/qa-attachment-orphan-sweep.postgres';

/**
 * The orphaned-bytes sweep against real Postgres: which rows it deletes, the
 * batch cap, and the advisory lock that keeps two api replicas from sweeping at
 * once. Replays the whole migration tree first, so the SQL and the index it
 * relies on are the ones production applies.
 *
 * Runs only when MIGRATION_TEST_DB_URL points at a throwaway database whose
 * role may SET session_replication_role (the local fixture's superuser). The
 * attachment rows are seeded with foreign-key triggers off so they do not need
 * whole run trees; every CHECK and NOT NULL still applies.
 */
const dbUrl = process.env['MIGRATION_TEST_DB_URL'];
const describeDatabase = dbUrl ? describe : describe.skip;

const migrationsRoot = resolve(__dirname, '../../supabase/migrations');
const SWEEP_LOCK_KEY = 'projects.qa_attachment_objects.orphan_sweep';
const TWO_HOURS = 2 * 60 * 60;
const ONE_HOUR = 60 * 60;

function migrationFiles(dir: string, relative = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const name = join(relative, entry.name);
    if (entry.isDirectory()) return migrationFiles(full, name);
    return entry.name.endsWith('.sql') ? [name] : [];
  });
}

describeDatabase('QA attachment orphan sweep (postgres)', () => {
  const admin = new Client({ connectionString: dbUrl });
  const pool = new Pool({ connectionString: dbUrl, max: 3 });
  const database = {
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as DatabaseService;
  const sweep = new PostgresQaAttachmentOrphanSweep(database);
  const prefix = `sweep-${randomUUID()}/`;

  beforeAll(async () => {
    await admin.connect();
    const existing = await admin.query<{ present: boolean }>(
      "SELECT to_regnamespace('projects') IS NOT NULL AS present",
    );
    if (existing.rows[0]?.present) {
      throw new Error(
        'MIGRATION_TEST_DB_URL must point at an empty database: a projects schema already exists.',
      );
    }
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
       END $$;
       CREATE SCHEMA IF NOT EXISTS extensions;
       -- Supabase Storage is absent from plain Postgres. The attachment
       -- migration writes one bucket row, so a stub with those columns is enough.
       CREATE SCHEMA IF NOT EXISTS storage;
       CREATE TABLE IF NOT EXISTS storage.buckets (
         id TEXT PRIMARY KEY, name TEXT, public BOOLEAN,
         file_size_limit BIGINT, allowed_mime_types TEXT[]
       );`,
    );
    const ordered = migrationFiles(migrationsRoot).sort((a, b) =>
      basename(a).localeCompare(basename(b)),
    );
    for (const file of ordered) {
      await admin.query(readFileSync(join(migrationsRoot, file), 'utf8'));
    }
  }, 180_000);

  beforeEach(async () => {
    // Throwaway database: start every case from an empty pair of tables.
    await admin.query(
      `SET session_replication_role = replica;
       DELETE FROM projects.qa_run_item_attachments;
       DELETE FROM projects.qa_attachment_objects;
       SET session_replication_role = origin;`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  /** An object whose created_at is `ageSeconds` in the past. Returns its path. */
  async function seedObject(name: string, ageSeconds: number): Promise<string> {
    const path = `${prefix}${name}`;
    await admin.query(
      `INSERT INTO projects.qa_attachment_objects
         (storage_path, content_type, byte_size, bytes, created_at)
       VALUES ($1, 'image/png', 4, $2, NOW() - ($3::int * INTERVAL '1 second'))`,
      [path, Buffer.from([0, 1, 2, 3]), ageSeconds],
    );
    return path;
  }

  /** A metadata row that references the object at `path`. */
  async function seedAttachment(path: string): Promise<void> {
    await admin.query('SET session_replication_role = replica');
    try {
      await admin.query(
        `INSERT INTO projects.qa_run_item_attachments
           (run_id, run_item_id, kind, storage_path, content_type, byte_size,
            width, height, source)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'evidence', $1, 'image/png',
                 4, 10, 10, 'capture')`,
        [path],
      );
    } finally {
      await admin.query('SET session_replication_role = origin');
    }
  }

  /** The object paths this case owns that are still stored. */
  async function remaining(): Promise<string[]> {
    const result = await admin.query<{ storage_path: string }>(
      `SELECT storage_path FROM projects.qa_attachment_objects
        WHERE storage_path LIKE $1 ORDER BY storage_path`,
      [`${prefix}%`],
    );
    return result.rows.map((row) => row.storage_path);
  }

  it('deletes only unreferenced objects past the grace period', async () => {
    const orphanOld = await seedObject('orphan-old', TWO_HOURS);
    const orphanOlder = await seedObject('orphan-older', TWO_HOURS * 3);
    const referencedOld = await seedObject('referenced-old', TWO_HOURS);
    await seedAttachment(referencedOld);
    const orphanFresh = await seedObject('orphan-fresh', 60);

    await expect(sweep.sweepOnce(500, ONE_HOUR)).resolves.toBe(2);

    const left = await remaining();
    expect(left).toEqual([referencedOld, orphanFresh].sort());
    expect(left).not.toContain(orphanOld);
    expect(left).not.toContain(orphanOlder);
  });

  it('caps each pass at the batch size and drains the backlog', async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedObject(`backlog-${String(index)}`, TWO_HOURS + index);
    }

    await expect(sweep.sweepOnce(2, ONE_HOUR)).resolves.toBe(2);
    await expect(sweep.sweepOnce(2, ONE_HOUR)).resolves.toBe(2);
    await expect(sweep.sweepOnce(2, ONE_HOUR)).resolves.toBe(1);
    await expect(sweep.sweepOnce(2, ONE_HOUR)).resolves.toBe(0);
    expect(await remaining()).toEqual([]);
  });

  it('deletes nothing while another replica holds the lock, then sweeps once it is released', async () => {
    await seedObject('locked-orphan', TWO_HOURS);
    const otherReplica = new Client({ connectionString: dbUrl });
    await otherReplica.connect();
    try {
      await otherReplica.query(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [SWEEP_LOCK_KEY],
      );

      await expect(sweep.sweepOnce()).resolves.toBeNull();
      expect(await remaining()).toHaveLength(1);

      await otherReplica.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [SWEEP_LOCK_KEY],
      );
      await expect(sweep.sweepOnce()).resolves.toBe(1);
      expect(await remaining()).toEqual([]);
    } finally {
      await otherReplica.end();
    }
  });

  it('two concurrent passes never double-delete: each orphan goes once', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedObject(`race-${String(index)}`, TWO_HOURS);
    }

    const results = await Promise.all([sweep.sweepOnce(), sweep.sweepOnce()]);

    const deleted = results.reduce<number>(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    expect(deleted).toBe(3);
    expect(await remaining()).toEqual([]);
  });

  it('keeps the created_at index the sweep depends on', async () => {
    const result = await admin.query(
      `SELECT 1 FROM pg_indexes
        WHERE schemaname = 'projects'
          AND tablename = 'qa_attachment_objects'
          AND indexname = 'idx_qa_attachment_objects_created_at'`,
    );
    expect(result.rowCount).toBe(1);
  });
});
