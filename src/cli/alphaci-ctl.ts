/**
 * alphaci-ctl: setup and checks for the self-hosted AlphaCI appliance.
 *
 * Runs inside the api image, through deploy/selfhost/alphaci-ctl:
 *
 *   docker compose run --rm --no-deps api node dist/src/cli/alphaci-ctl.js doctor
 *
 * Exit codes: 0 success, 1 a check failed or the database step failed, 2 usage.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { applyFileEnv } from '../kernel/config/file-env';
import { postgresSslConfig } from '../kernel/db/postgres-ssl.config';
import {
  LEDGER_TABLE,
  listUpMigrations,
  resolveSelfhostAssetPaths,
} from '../scripts/selfhost-migrations';

import {
  grantSuperAdmin,
  AdminGrantError,
  type SqlRunner,
} from './admin-grant';
import { parseArgs, UsageError, USAGE, type CliCommand } from './args';
import { runDoctor, formatResults, type DoctorProbes } from './doctor';
import { releaseKeyId } from './release-key';
import { InitError, runInit, SECRET_FILES } from './selfhost-init';
import { createHostEnrollment, HostEnrollmentError } from './host-enrollment';

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const HTTPS_PROBE_TIMEOUT_MS = 10_000;

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  let command: CliCommand;
  try {
    command = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err('Run alphaci-ctl help for usage.');
      return 2;
    }
    throw error;
  }

  switch (command.name) {
    case 'help':
      io.out(USAGE);
      return 0;
    case 'init':
      return runInitCommand(command, io);
    case 'admin-grant':
      return runAdminGrant(command.githubLogin, env, io);
    case 'doctor':
      return runDoctorCommand(env, io);
    case 'host-enrollment':
      return runHostEnrollment(command, env, io);
  }
}

function runInitCommand(
  command: Extract<CliCommand, { name: 'init' }>,
  io: CliIo,
): number {
  try {
    const report = runInit({
      dir: command.dir,
      hostname: command.hostname,
      tls: command.tls,
    });
    for (const path of report.created) io.out(`created ${path}`);
    for (const path of report.kept)
      io.out(`kept    ${path} (already exists, not changed)`);

    const keyPath = join(
      command.dir,
      'secrets',
      SECRET_FILES.releaseSigningKey,
    );
    const pem = readFileSync(keyPath, 'utf8');
    io.out(`release signing key ID: ${releaseKeyId(pem)}`);

    if (report.missingCustomerSecrets.length > 0) {
      io.out('');
      io.out('Still to place by hand in secrets/ before compose up:');
      for (const name of report.missingCustomerSecrets) io.out(`  ${name}`);
    }
    io.out('');
    io.out(
      'Next: fill in the GitHub values in alphaci.env, place the secrets above, then run compose up.',
    );
    io.out(`Public address: https://${command.hostname} (TLS: ${command.tls})`);
    return 0;
  } catch (error) {
    if (error instanceof InitError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}

async function runAdminGrant(
  login: string,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const loaded = loadSecretFiles(env, io);
  if (loaded !== 0) return loaded;

  const url = env['DATABASE_URL']?.trim() ?? '';
  if (url === '') {
    io.err('DATABASE_URL (or DATABASE_URL_FILE) is not set.');
    return 2;
  }
  const client = openClient(url, env);
  try {
    await client.connect();
    const runner: SqlRunner = {
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
    const publicUrl =
      env['PLATFORM_PUBLIC_URL']?.trim() || 'the public address';
    const result = await grantSuperAdmin(runner, login, publicUrl);
    const before =
      result.previousRole === null
        ? 'an ordinary user'
        : `a ${result.previousRole}`;
    io.out(`Granted super_admin to ${result.login} (was ${before}).`);
    return 0;
  } catch (error) {
    if (error instanceof AdminGrantError) {
      io.err(error.message);
      return 1;
    }
    io.err(`Database step failed: ${describe(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Prints only the code on stdout, so server-host can capture it. */
async function runHostEnrollment(
  command: Extract<CliCommand, { name: 'host-enrollment' }>,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const loaded = loadSecretFiles(env, io);
  if (loaded !== 0) return loaded;
  const url = env['DATABASE_URL']?.trim() ?? '';
  if (url === '') {
    io.err('DATABASE_URL (or DATABASE_URL_FILE) is not set.');
    return 2;
  }
  const client = openClient(url, env);
  try {
    await client.connect();
    const result = await createHostEnrollment(
      {
        query: async <Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ) => ({
          rows: (
            await client.query<Row>(text, values ? [...values] : undefined)
          ).rows,
        }),
      },
      {
        team: command.team,
        githubLogin: command.githubLogin,
        name: command.hostName,
      },
    );
    io.err(`Enrollment created for team ${result.team}; it works once.`);
    io.out(result.code);
    return 0;
  } catch (error) {
    if (error instanceof HostEnrollmentError) {
      io.err(error.message);
      return 1;
    }
    io.err(`Database step failed: ${describe(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runDoctorCommand(
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const loaded = loadSecretFiles(env, io);
  if (loaded !== 0) return loaded;

  const probes = databaseProbes(env);
  try {
    const results = await runDoctor(env, probes.probes);
    io.out(formatResults(results));
    return results.every((result) => result.ok) ? 0 : 1;
  } finally {
    await probes.close();
  }
}

/** Resolves the *_FILE settings. Reports a bad secret file as a usage problem. */
function loadSecretFiles(env: NodeJS.ProcessEnv, io: CliIo): number {
  try {
    applyFileEnv(env);
    return 0;
  } catch (error) {
    io.err(describe(error));
    return 2;
  }
}

interface DatabaseProbes {
  readonly probes: DoctorProbes;
  close(): Promise<void>;
}

/** Doctor's database and file probes, backed by one pg client opened on first use. */
function databaseProbes(env: NodeJS.ProcessEnv): DatabaseProbes {
  const url = env['DATABASE_URL']?.trim() ?? '';
  let client: Client | undefined;
  const connected = async (): Promise<Client> => {
    if (client === undefined) {
      if (url === '') throw new Error('DATABASE_URL is not set');
      const next = openClient(url, env);
      await next.connect();
      client = next;
    }
    return client;
  };

  const probes: DoctorProbes = {
    checkDatabase: async () => {
      const db = await connected();
      await db.query('SELECT 1');
    },
    readLedger: async () => {
      const db = await connected();
      const result = await db.query<{ version: string; checksum: string }>(
        `SELECT version, checksum FROM ${LEDGER_TABLE}`,
      );
      return new Map(result.rows.map((row) => [row.version, row.checksum]));
    },
    listMigrations: () =>
      listUpMigrations(resolveSelfhostAssetPaths(__dirname).migrationsDir),
    readFile: (path) => readFileSync(path, 'utf8'),
    probeHttps: async (target) => {
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(HTTPS_PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.status;
    },
  };

  return {
    probes,
    close: async () => {
      await client?.end().catch(() => undefined);
    },
  };
}

function openClient(url: string, env: NodeJS.ProcessEnv): Client {
  return new Client({
    connectionString: url,
    ssl: postgresSslConfig(
      url,
      // The API reads SUPABASE_DB_CA_CERT; installs that set only that one
      // (a hosted database) need the CLI to verify the same server.
      env['DATABASE_CA_CERT'] || env['SUPABASE_DB_CA_CERT'],
    ),
    application_name: 'alphaci-ctl',
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(describe(error));
      process.exitCode = 1;
    });
}
