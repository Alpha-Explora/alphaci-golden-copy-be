import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Client } from 'pg';

const REPOSITORY_ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS_ROOT = join(REPOSITORY_ROOT, 'supabase', 'migrations');
const ROLLBACKS_ROOT = join(REPOSITORY_ROOT, 'supabase', 'rollbacks');

export const FIXTURE_COMPOSE_FILE = join(
  REPOSITORY_ROOT,
  'tests',
  'integration',
  'database',
  'compose.yaml',
);
export const FIXTURE_COMPOSE_PROJECT = 'alphaci-e2e';
export const FIXTURE_ADMIN_URL =
  'postgresql://alphaci_migration_test:alphaci_migration_test_only@127.0.0.1:55432/alphaci_migration_test';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Refuse anything but a loopback database; E2E runs drop and create databases. */
export function assertLoopbackDatabaseUrl(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      'E2E refuses database host "' +
        host +
        '". Point E2E_DATABASE_URL at the disposable loopback fixture.',
    );
  }
}

export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = '/' + database;
  return url.toString();
}

export function uniqueDatabaseName(purpose: string): string {
  return 'alphaci_e2e_' + purpose + '_' + String(Date.now());
}

/** The row a query must have returned; a missing row fails the scenario. */
export function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('Expected a row, got none.');
  return row;
}

function assertDatabaseName(name: string): void {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error('Unsafe E2E database name: ' + name);
  }
}

export async function withClient<T>(
  url: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  assertLoopbackDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function createDatabase(
  adminUrl: string,
  name: string,
): Promise<string> {
  assertDatabaseName(name);
  await withClient(adminUrl, async (client) => {
    await client.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await client.query('CREATE DATABASE "' + name + '"');
  });
  const url = databaseUrl(adminUrl, name);
  // Supabase owns this platform table; plain PostgreSQL fixtures do not ship it.
  // This supports migration replay only, not object-storage behavior.
  await withClient(url, async (client) => {
    await client.query(`CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (
        id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
        file_size_limit bigint, allowed_mime_types text[]
      );`);
  });
  return url;
}

export async function dropDatabase(
  adminUrl: string,
  name: string,
): Promise<void> {
  assertDatabaseName(name);
  await withClient(adminUrl, (client) =>
    client.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)'),
  );
}

/** Every migration in the replay order used by scripts/apply-all-migrations.mjs. */
export function migrationFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.sql') ? [path] : [];
    });
  return walk(MIGRATIONS_ROOT).sort((left, right) =>
    basename(left).localeCompare(basename(right)),
  );
}

export function rollbackFile(migrationName: string): string {
  return join(ROLLBACKS_ROOT, migrationName.replace(/\.sql$/, '_down.sql'));
}

/** Apply each file in its own transaction, as scripts/apply-migrations.ts does. */
export async function applySqlFiles(
  url: string,
  files: string[],
): Promise<void> {
  await withClient(url, async (client) => {
    for (const file of files) {
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(file, 'utf8'));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          'Applying ' + basename(file) + ' failed: ' + String(error),
        );
      }
    }
  });
}
