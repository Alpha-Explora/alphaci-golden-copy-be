/**
 * selfhost-migrations.ts
 *
 * Applies the Supabase migration tree (supabase/migrations/<owner>/*.sql) to a
 * plain PostgreSQL database, for the self-hosted deployment. SaaS keeps using
 * the Supabase CLI and scripts/apply-all-migrations.mjs, which are unchanged.
 *
 * What a run does, in order:
 *   1. Discover up migrations in the same global order as
 *      scripts/apply-all-migrations.mjs (basename, locale compare).
 *   2. Take a session-level pg_advisory_lock so two starting containers cannot
 *      interleave migrations. The lock is released in `finally`.
 *   3. Run the Supabase-compatible role bootstrap (deploy/selfhost/postgres-init
 *      /00-roles.sql), which creates the anon and authenticated roles if missing.
 *   4. Create the ledger public.schema_migrations(version, applied_at, checksum).
 *   5. Compare each recorded checksum with the file on disk. A mismatch stops the
 *      run before anything is applied.
 *   6. Apply each pending migration in order and record it.
 *
 * Transaction handling per file:
 *   - wrapped:          BEGIN; <sql>; INSERT ledger; COMMIT. Effects and ledger row
 *                       commit together.
 *   - self-managed:     the file opens its own BEGIN. It runs unwrapped, and the
 *                       ledger row is written right after its COMMIT. A crash in
 *                       that gap leaves the file applied but unrecorded, so the
 *                       next run re-applies it. Those files are idempotent.
 *   - non-transactional: the file uses CREATE INDEX CONCURRENTLY, VACUUM, or
 *                       similar, which cannot run inside a transaction. It also
 *                       runs unwrapped, with the same caveat. The repository has
 *                       none today.
 *
 * Failures stop the run. Later migrations often ALTER what earlier ones create.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Advisory lock key for the self-hosted migration runner ("ALPM"). */
export const MIGRATION_LOCK_KEY = 1095520333;

export const LEDGER_TABLE = 'public.schema_migrations';

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL
);
ALTER TABLE ${LEDGER_TABLE} ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ${LEDGER_TABLE} FROM anon, authenticated;
`;

export type TransactionMode = 'wrapped' | 'self-managed' | 'non-transactional';

export interface MigrationFile {
  /**
   * Filename without `.sql`, for example 20260617000100_platform_admins. The
   * numeric prefix alone is not unique in this tree (two files share
   * 20261015010000), so the full stem is the ledger key.
   */
  readonly version: string;
  /** Path relative to the migrations root, using forward slashes. */
  readonly relativePath: string;
  readonly sql: string;
  readonly checksum: string;
  readonly transactionMode: TransactionMode;
}

/** Minimal query surface, so the runner can be exercised without a live server. */
export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface MigrationRunOptions {
  readonly migrationsDir: string;
  readonly bootstrapSqlPath: string;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface MigrationRunSummary {
  readonly total: number;
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
  readonly unknownRecorded: readonly string[];
}

export class MigrationChecksumMismatchError extends Error {
  constructor(
    readonly version: string,
    readonly relativePath: string,
    readonly recordedChecksum: string,
    readonly currentChecksum: string,
  ) {
    super(
      `Migration ${version} (${relativePath}) was already applied with checksum ` +
        `${recordedChecksum}, but the file on disk now has checksum ${currentChecksum}. ` +
        'Applied migrations must not change. Restore the original file, or add a new ' +
        'migration for the change. If the file change is intentional and the database ' +
        `was repaired by hand, update ${LEDGER_TABLE}.checksum for version ${version}.`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export class MigrationOrderError extends Error {
  constructor(
    readonly pendingPath: string,
    readonly appliedPath: string,
  ) {
    super(
      `Pending migration ${pendingPath} sorts before already-applied migration ${appliedPath}. ` +
        'Replaying it would change history that other databases already have. Rename the ' +
        'new migration to a later timestamp, or resolve the ledger by hand.',
    );
    this.name = 'MigrationOrderError';
  }
}

export class MigrationApplyError extends Error {
  constructor(
    readonly relativePath: string,
    cause: unknown,
  ) {
    super(`Migration ${relativePath} failed: ${describeError(cause)}`, {
      cause,
    });
    this.name = 'MigrationApplyError';
  }
}

/**
 * Lists up migrations under migrationsDir in the same global order as
 * scripts/apply-all-migrations.mjs: recursive discovery, then a sort on the
 * basename with localeCompare.
 */
export function listUpMigrations(migrationsDir: string): MigrationFile[] {
  const paths = listSqlPaths(migrationsDir).sort((a, b) =>
    basename(a).localeCompare(basename(b)),
  );
  if (paths.length === 0) {
    throw new Error(`No migrations found under ${migrationsDir}`);
  }

  const seen = new Map<string, string>();
  return paths.map((relativePath) => {
    const version = versionOf(relativePath);
    const previous = seen.get(version);
    if (previous) {
      throw new Error(
        `Duplicate migration version ${version}: ${previous} and ${relativePath}. ` +
          'Each migration basename must be unique across the tree.',
      );
    }
    seen.set(version, relativePath);

    const sql = readFileSync(join(migrationsDir, relativePath), 'utf8');
    return {
      version,
      relativePath,
      sql,
      checksum: checksumSql(sql),
      transactionMode: classifyTransactionMode(sql),
    };
  });
}

function listSqlPaths(dir: string, relative = ''): string[] {
  return readdirSync(join(dir, relative), { withFileTypes: true }).flatMap(
    (entry) => {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) return listSqlPaths(dir, name);
      return entry.name.endsWith('.sql') ? [name.replaceAll('\\', '/')] : [];
    },
  );
}

function versionOf(relativePath: string): string {
  return basename(relativePath).replace(/\.sql$/, '');
}

/** SHA-256 of the SQL with CRLF normalized to LF, so a Windows checkout matches. */
export function checksumSql(sql: string): string {
  return createHash('sha256')
    .update(sql.replaceAll('\r\n', '\n'), 'utf8')
    .digest('hex');
}

/**
 * Decides how a file runs. Comments, string literals, quoted identifiers and
 * dollar-quoted bodies are stripped first, so a BEGIN inside a string or a
 * comment does not count.
 */
export function classifyTransactionMode(sql: string): TransactionMode {
  const code = stripNonCode(sql);
  if (
    /\bCONCURRENTLY\b/i.test(code) ||
    /(^|;)\s*VACUUM\b/i.test(code) ||
    /\b(CREATE|DROP)\s+DATABASE\b/i.test(code) ||
    /\bALTER\s+SYSTEM\b/i.test(code)
  ) {
    return 'non-transactional';
  }
  if (/(^|;)\s*(BEGIN|START\s+TRANSACTION)\b/i.test(code)) {
    return 'self-managed';
  }
  return 'wrapped';
}

/** Replaces comments, quoted strings and identifiers, and dollar-quoted bodies with placeholders. */
export function stripNonCode(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.charAt(i) === '/' && sql.charAt(i + 1) === '*') {
          depth += 1;
          i += 2;
        } else if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += ' ';
      continue;
    }

    if (ch === "'" || ch === '"') {
      i = skipQuoted(sql, i, ch);
      out += ch + ch;
      continue;
    }

    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        out += ' $$ ';
        continue;
      }
    }

    out += ch;
    i += 1;
  }
  return out;
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql.charAt(i) === quote) {
      if (sql.charAt(i + 1) === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

export interface MigrationPlan {
  readonly pending: readonly MigrationFile[];
  readonly alreadyApplied: number;
  readonly unknownRecorded: readonly string[];
}

/**
 * Compares the ledger with the files on disk. It throws before anything is
 * applied when a recorded checksum differs, or when a pending migration would
 * sort before one that is already recorded.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<string, string>,
): MigrationPlan {
  const byVersion = new Map(files.map((file) => [file.version, file]));

  for (const file of files) {
    const recorded = applied.get(file.version);
    if (recorded !== undefined && recorded !== file.checksum) {
      throw new MigrationChecksumMismatchError(
        file.version,
        file.relativePath,
        recorded,
        file.checksum,
      );
    }
  }

  const unknownRecorded = [...applied.keys()]
    .filter((version) => !byVersion.has(version))
    .sort();

  const pending = files.filter((file) => !applied.has(file.version));
  const lastAppliedIndex = files.reduce(
    (max, file, index) => (applied.has(file.version) ? index : max),
    -1,
  );
  const firstOutOfOrder = files.find(
    (file, index) => index < lastAppliedIndex && !applied.has(file.version),
  );
  if (firstOutOfOrder) {
    throw new MigrationOrderError(
      firstOutOfOrder.relativePath,
      files[lastAppliedIndex]?.relativePath ?? '(unknown)',
    );
  }

  return {
    pending,
    alreadyApplied: files.length - pending.length,
    unknownRecorded,
  };
}

/**
 * Applies the role bootstrap and every pending migration against db. The caller
 * owns the connection. The advisory lock is taken on that connection, so run
 * this on a dedicated session.
 */
export async function runSelfhostMigrations(
  db: SqlClient,
  options: MigrationRunOptions,
): Promise<MigrationRunSummary> {
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const files = listUpMigrations(options.migrationsDir);
  const bootstrapSql = readFileSync(options.bootstrapSqlPath, 'utf8');

  await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await runInTransaction(db, bootstrapSql);
    await db.query(LEDGER_DDL);

    const applied = await readLedger(db);
    const plan = planMigrations(files, applied);

    for (const version of plan.unknownRecorded) {
      warn(
        `ledger has version ${version} with no matching file in ${options.migrationsDir}; ` +
          'leaving it in place (the image may be older than the database).',
      );
    }
    log(
      `${plan.pending.length} pending, ${plan.alreadyApplied} already applied, ${files.length} total`,
    );

    const appliedNow: string[] = [];
    for (const file of plan.pending) {
      await applyOne(db, file, log, warn);
      appliedNow.push(file.relativePath);
    }

    log(`done: ${appliedNow.length} applied`);
    return {
      total: files.length,
      applied: appliedNow,
      alreadyApplied: plan.alreadyApplied,
      unknownRecorded: plan.unknownRecorded,
    };
  } finally {
    await db
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
  }
}

async function runInTransaction(db: SqlClient, sql: string): Promise<void> {
  await db.query('BEGIN');
  try {
    await db.query(sql);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function readLedger(db: SqlClient): Promise<Map<string, string>> {
  const result = await db.query<{ version: string; checksum: string }>(
    `SELECT version, checksum FROM ${LEDGER_TABLE}`,
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

async function applyOne(
  db: SqlClient,
  file: MigrationFile,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  const record = async (): Promise<void> => {
    await db.query(
      `INSERT INTO ${LEDGER_TABLE} (version, checksum) VALUES ($1, $2)`,
      [file.version, file.checksum],
    );
  };

  try {
    if (file.transactionMode === 'wrapped') {
      await db.query('BEGIN');
      try {
        await db.query(file.sql);
        await record();
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } else {
      if (file.transactionMode === 'non-transactional') {
        warn(
          `${file.relativePath} cannot run in a transaction; a failure part-way leaves partial effects.`,
        );
      }
      try {
        await db.query(file.sql);
      } catch (error) {
        // A self-managed file can leave its own transaction open after an error.
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      await record();
    }
  } catch (error) {
    throw new MigrationApplyError(file.relativePath, error);
  }

  log(`applied ${file.version} ${file.relativePath} (${file.transactionMode})`);
}

/**
 * Walks up from startDir until a directory holds supabase/migrations. The same
 * code runs from src/scripts (ts-node) and from dist/src/scripts (the image).
 */
export function resolveSelfhostAssetPaths(startDir: string): {
  readonly migrationsDir: string;
  readonly bootstrapSqlPath: string;
} {
  let current = resolve(startDir);
  for (;;) {
    const migrationsDir = join(current, 'supabase', 'migrations');
    if (existsSync(migrationsDir)) {
      return {
        migrationsDir,
        bootstrapSqlPath: join(
          current,
          'deploy',
          'selfhost',
          'postgres-init',
          '00-roles.sql',
        ),
      };
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not find supabase/migrations above ${startDir}. Pass the migrations directory explicitly.`,
      );
    }
    current = parent;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const position = (error as { position?: unknown }).position;
    const parts = [error.message];
    if (typeof code === 'string') parts.push(`SQLSTATE ${code}`);
    if (typeof position === 'string') parts.push(`at character ${position}`);
    return parts.join(' ');
  }
  return String(error);
}
