/**
 * migrate-selfhost.ts
 *
 * Command-line entry for the self-hosted migration runner. The compiled file
 * runs in the production image with only node and the production dependencies:
 *
 *   node dist/src/scripts/migrate-selfhost.js            # apply pending migrations
 *   node dist/src/scripts/migrate-selfhost.js --dry-run  # list them, touch nothing
 *
 * Environment:
 *   DATABASE_URL          plain PostgreSQL connection string (preferred)
 *   DATABASE_URL_FILE     the same, read from a file (secret mount)
 *   SUPABASE_DB_URL       fallback, for parity with the SaaS scripts
 *   DATABASE_CA_CERT      optional PEM for TLS; falls back to SUPABASE_DB_CA_CERT
 *
 * TLS follows the backend's rule (postgresSslConfig): loopback hosts connect
 * without TLS, other hosts use TLS, and a pinned CA is used when one is set.
 *
 * Exit codes: 0 success, 1 migration or connection failure, 2 misconfiguration.
 */

import { Client } from 'pg';

import { applyFileEnv } from '../kernel/config/file-env';
import { postgresSslConfig } from '../kernel/db/postgres-ssl.config';

import {
  listUpMigrations,
  resolveSelfhostAssetPaths,
  runSelfhostMigrations,
} from './selfhost-migrations';

async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const assets = resolveSelfhostAssetPaths(__dirname);

  if (argv.includes('--dry-run')) {
    const files = listUpMigrations(assets.migrationsDir);
    console.log(`${files.length} migration(s) in ${assets.migrationsDir}\n`);
    files.forEach((file, index) => {
      console.log(
        `  ${String(index + 1).padStart(2)}. ${file.relativePath} (${file.transactionMode}) ${file.checksum.slice(0, 12)}`,
      );
    });
    console.log('\ndry run, nothing was applied');
    return 0;
  }

  const databaseUrl = (
    env['DATABASE_URL'] ||
    env['SUPABASE_DB_URL'] ||
    ''
  ).trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL (or SUPABASE_DB_URL) is required');
    return 2;
  }
  const caCert = env['DATABASE_CA_CERT'] || env['SUPABASE_DB_CA_CERT'];

  const client = new Client({
    connectionString: databaseUrl,
    ssl: postgresSslConfig(databaseUrl, caCert),
    application_name: 'alphaci-selfhost-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`Could not connect to the database: ${describe(error)}`);
    return 1;
  }

  try {
    console.log(`Connected to ${safeHost(databaseUrl)}`);
    await runSelfhostMigrations(
      {
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
      },
      {
        migrationsDir: assets.migrationsDir,
        bootstrapSqlPath: assets.bootstrapSqlPath,
      },
    );
    return 0;
  } catch (error) {
    console.error(`\nSelf-hosted migration run stopped: ${describe(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeHost(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'the configured database';
  }
}

if (require.main === module) {
  try {
    applyFileEnv(process.env);
    main(process.argv.slice(2), process.env)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(describe(error));
        process.exitCode = 1;
      });
  } catch (error) {
    console.error(describe(error));
    process.exitCode = 2;
  }
}
