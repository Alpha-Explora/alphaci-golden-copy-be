import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  checksumSql,
  classifyTransactionMode,
  listUpMigrations,
  MigrationApplyError,
  MigrationChecksumMismatchError,
  type MigrationFile,
  MigrationOrderError,
  planMigrations,
  type SqlClient,
  resolveSelfhostAssetPaths,
  runSelfhostMigrations,
  stripNonCode,
} from './selfhost-migrations';

const repositoryRoot = resolve(__dirname, '..', '..');
const migrationsDir = join(repositoryRoot, 'supabase', 'migrations');
const bootstrapSqlPath = join(
  repositoryRoot,
  'deploy',
  'selfhost',
  'postgres-init',
  '00-roles.sql',
);

function fileOf(
  version: string,
  relativePath: string,
  sql = 'SELECT 1;',
): MigrationFile {
  return {
    version,
    relativePath,
    sql,
    checksum: checksumSql(sql),
    transactionMode: classifyTransactionMode(sql),
  };
}

describe('listUpMigrations', () => {
  it('matches the replay order of scripts/apply-all-migrations.mjs exactly', () => {
    const planned = execFileSync(
      process.execPath,
      [
        join(repositoryRoot, 'scripts', 'apply-all-migrations.mjs'),
        '--dry-run',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => /^\s+\d+\.\s+(.+)$/.exec(line)?.[1]?.trim())
      .filter((value): value is string => value !== undefined)
      .map((value) => value.replaceAll('\\', '/'));

    const ours = listUpMigrations(migrationsDir).map(
      (file) => file.relativePath,
    );

    expect(planned.length).toBeGreaterThan(0);
    expect(ours).toEqual(planned);
  });

  it('sorts by basename across owner folders, not by folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'selfhost-order-'));
    try {
      mkdirSync(join(root, 'a'));
      mkdirSync(join(root, 'b'));
      writeFileSync(join(root, 'b', '20260102_second.sql'), 'SELECT 2;');
      writeFileSync(join(root, 'a', '20260103_third.sql'), 'SELECT 3;');
      writeFileSync(join(root, 'a', '20260101_first.sql'), 'SELECT 1;');

      expect(listUpMigrations(root).map((file) => file.version)).toEqual([
        '20260101_first',
        '20260102_second',
        '20260103_third',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects two files with the same basename in different owner folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'selfhost-dup-'));
    try {
      mkdirSync(join(root, 'a'));
      mkdirSync(join(root, 'b'));
      writeFileSync(join(root, 'a', '20260101_same.sql'), 'SELECT 1;');
      writeFileSync(join(root, 'b', '20260101_same.sql'), 'SELECT 2;');

      expect(() => listUpMigrations(root)).toThrow(
        /Duplicate migration version 20260101_same/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts two files that share a numeric prefix but differ in name', () => {
    const root = mkdtempSync(join(tmpdir(), 'selfhost-prefix-'));
    try {
      writeFileSync(join(root, '20261015010000_one.sql'), 'SELECT 1;');
      writeFileSync(join(root, '20261015010000_two.sql'), 'SELECT 2;');

      expect(listUpMigrations(root).map((file) => file.version)).toEqual([
        '20261015010000_one',
        '20261015010000_two',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('classifyTransactionMode', () => {
  it('wraps a plain file in the runner transaction', () => {
    expect(classifyTransactionMode('CREATE TABLE t (id int);')).toBe('wrapped');
  });

  it('detects a file that opens its own transaction', () => {
    expect(
      classifyTransactionMode('BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;'),
    ).toBe('self-managed');
    expect(classifyTransactionMode('start transaction;\nSELECT 1;')).toBe(
      'self-managed',
    );
  });

  it('ignores BEGIN inside comments, strings and dollar-quoted bodies', () => {
    expect(
      classifyTransactionMode(
        "-- BEGIN;\nSELECT 'BEGIN;';\n/* COMMIT; */\nDO $$ BEGIN\n  PERFORM 1;\nEND $$;",
      ),
    ).toBe('wrapped');
  });

  it('marks CONCURRENTLY, VACUUM and database-level statements as non-transactional', () => {
    expect(
      classifyTransactionMode('CREATE INDEX CONCURRENTLY idx ON t (id);'),
    ).toBe('non-transactional');
    expect(classifyTransactionMode('VACUUM ANALYZE t;')).toBe(
      'non-transactional',
    );
    expect(classifyTransactionMode('CREATE DATABASE other;')).toBe(
      'non-transactional',
    );
  });

  it('keeps comments out of code scanning', () => {
    expect(
      stripNonCode(
        "SELECT 'it''s'; -- trailing\n/* nested /* x */ */ SELECT 2;",
      ),
    ).not.toMatch(/trailing|nested/);
  });
});

describe('checksumSql', () => {
  it('is the same for LF and CRLF checkouts of one file', () => {
    expect(checksumSql('CREATE TABLE a ();\nSELECT 1;\n')).toBe(
      checksumSql('CREATE TABLE a ();\r\nSELECT 1;\r\n'),
    );
  });

  it('changes when the SQL changes', () => {
    expect(checksumSql('SELECT 1;')).not.toBe(checksumSql('SELECT 2;'));
  });
});

describe('planMigrations', () => {
  const first = fileOf('20260101', 'x/20260101_first.sql', 'SELECT 1;');
  const second = fileOf('20260102', 'x/20260102_second.sql', 'SELECT 2;');
  const third = fileOf('20260103', 'x/20260103_third.sql', 'SELECT 3;');

  it('returns only files that are not recorded yet', () => {
    const plan = planMigrations(
      [first, second, third],
      new Map([[first.version, first.checksum]]),
    );

    expect(plan.pending.map((file) => file.version)).toEqual([
      '20260102',
      '20260103',
    ]);
    expect(plan.alreadyApplied).toBe(1);
    expect(plan.unknownRecorded).toEqual([]);
  });

  it('fails on a checksum mismatch with a message that names the file', () => {
    const edited = { ...first, checksum: 'different' };
    const applied = new Map([[first.version, first.checksum]]);

    let caught: unknown;
    try {
      planMigrations([edited, second], applied);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationChecksumMismatchError);
    expect((caught as Error).message).toContain('20260101');
    expect((caught as Error).message).toContain('x/20260101_first.sql');
    expect((caught as Error).message).toContain(
      'Applied migrations must not change',
    );
  });

  it('reports recorded versions that have no file, without failing', () => {
    const plan = planMigrations(
      [first],
      new Map([
        [first.version, first.checksum],
        ['20991231', 'abc'],
      ]),
    );

    expect(plan.unknownRecorded).toEqual(['20991231']);
    expect(plan.pending).toEqual([]);
  });

  it('refuses to apply a pending file that sorts before an applied one', () => {
    expect(() =>
      planMigrations(
        [first, second, third],
        new Map([
          [first.version, first.checksum],
          [third.version, third.checksum],
        ]),
      ),
    ).toThrow(MigrationOrderError);
  });
});

describe('runSelfhostMigrations', () => {
  let root: string;
  let bootstrap: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'selfhost-run-'));
    bootstrap = join(root, '00-roles.sql');
    writeFileSync(bootstrap, 'DO $$ BEGIN END $$;');
    mkdirSync(join(root, 'migrations', 'owner'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeMigration(name: string, sql: string): void {
    writeFileSync(join(root, 'migrations', 'owner', name), sql);
  }

  function fakeDatabase(recorded: Map<string, string> = new Map()) {
    const statements: string[] = [];
    const db: SqlClient = {
      query: (text: string, values?: readonly unknown[]) => {
        statements.push(text);
        if (text.startsWith('SELECT version, checksum')) {
          return Promise.resolve({
            rows: [...recorded].map(([version, checksum]) => ({
              version,
              checksum,
            })) as never[],
          });
        }
        if (text.startsWith('INSERT INTO public.schema_migrations')) {
          const [version, checksum] = values as [string, string];
          recorded.set(version, checksum);
        }
        return Promise.resolve({ rows: [] as never[] });
      },
    };
    return { db, statements, recorded };
  }

  const options = () => ({
    migrationsDir: join(root, 'migrations'),
    bootstrapSqlPath: bootstrap,
    log: () => undefined,
    warn: () => undefined,
  });

  it('takes the advisory lock first, releases it last, and records each file', async () => {
    writeMigration('20260101_a.sql', 'CREATE TABLE a (id int);');
    writeMigration('20260102_b.sql', 'CREATE TABLE b (id int);');
    const { db, statements, recorded } = fakeDatabase();

    const summary = await runSelfhostMigrations(db, options());

    expect(statements[0]).toBe('SELECT pg_advisory_lock($1)');
    expect(statements.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(summary.applied).toEqual([
      'owner/20260101_a.sql',
      'owner/20260102_b.sql',
    ]);
    expect([...recorded.keys()]).toEqual(['20260101_a', '20260102_b']);

    const createA = statements.indexOf('CREATE TABLE a (id int);');
    const createB = statements.indexOf('CREATE TABLE b (id int);');
    expect(createA).toBeGreaterThan(0);
    expect(createB).toBeGreaterThan(createA);
  });

  it('wraps a plain file in BEGIN and COMMIT with its ledger row', async () => {
    writeMigration('20260101_a.sql', 'CREATE TABLE a (id int);');
    const { db, statements } = fakeDatabase();

    await runSelfhostMigrations(db, options());

    const migration = statements.indexOf('CREATE TABLE a (id int);');
    expect(statements[migration - 1]).toBe('BEGIN');
    expect(statements.slice(migration, migration + 3)).toEqual([
      'CREATE TABLE a (id int);',
      expect.stringContaining('INSERT INTO public.schema_migrations'),
      'COMMIT',
    ]);
  });

  it('skips recorded versions and applies only the rest', async () => {
    writeMigration('20260101_a.sql', 'CREATE TABLE a (id int);');
    writeMigration('20260102_b.sql', 'CREATE TABLE b (id int);');
    const sqlA = 'CREATE TABLE a (id int);';
    const { db, statements } = fakeDatabase(
      new Map([['20260101_a', checksumSql(sqlA)]]),
    );

    const summary = await runSelfhostMigrations(db, options());

    expect(summary.applied).toEqual(['owner/20260102_b.sql']);
    expect(statements).not.toContain('CREATE TABLE a (id int);');
    expect(statements).toContain('CREATE TABLE b (id int);');
  });

  it('stops on a checksum mismatch before any migration SQL runs', async () => {
    writeMigration('20260101_a.sql', 'CREATE TABLE a (id int);');
    writeMigration('20260102_b.sql', 'CREATE TABLE b (id int);');
    const { db, statements } = fakeDatabase(
      new Map([['20260101_a', 'not-the-real-checksum']]),
    );

    await expect(runSelfhostMigrations(db, options())).rejects.toBeInstanceOf(
      MigrationChecksumMismatchError,
    );
    expect(statements).not.toContain('CREATE TABLE b (id int);');
    expect(statements.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('rolls back a failing file, releases the lock, and stops the run', async () => {
    writeMigration('20260101_a.sql', 'CREATE TABLE a (id int);');
    writeMigration('20260102_b.sql', 'BROKEN SQL;');
    writeMigration('20260103_c.sql', 'CREATE TABLE c (id int);');
    const statements: string[] = [];
    const recorded = new Map<string, string>();
    const db: SqlClient = {
      query: (text: string, values?: readonly unknown[]) => {
        statements.push(text);
        if (text === 'BROKEN SQL;') {
          return Promise.reject(
            Object.assign(new Error('syntax error at or near "BROKEN"'), {
              code: '42601',
            }),
          );
        }
        if (text.startsWith('SELECT version, checksum')) {
          return Promise.resolve({ rows: [] as never[] });
        }
        if (text.startsWith('INSERT INTO public.schema_migrations')) {
          const [version, checksum] = values as [string, string];
          recorded.set(version, checksum);
        }
        return Promise.resolve({ rows: [] as never[] });
      },
    };

    let caught: unknown;
    try {
      await runSelfhostMigrations(db, options());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationApplyError);
    expect((caught as Error).message).toContain('owner/20260102_b.sql');
    expect((caught as Error).message).toContain('SQLSTATE 42601');
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('CREATE TABLE c (id int);');
    expect([...recorded.keys()]).toEqual(['20260101_a']);
    expect(statements.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('serializes two concurrent runs on the advisory lock', async () => {
    writeMigration('20260101_a.sql', 'CREATE TABLE a (id int);');
    writeMigration('20260102_b.sql', 'CREATE TABLE b (id int);');

    // One fake server models the advisory lock as a mutex shared by sessions.
    const events: string[] = [];
    const recorded = new Map<string, string>();
    let holder: string | null = null;
    const waiters: Array<() => void> = [];

    const sessionFor = (name: string): SqlClient => ({
      query: async (text: string, values?: readonly unknown[]) => {
        if (text === 'SELECT pg_advisory_lock($1)') {
          while (holder !== null) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          holder = name;
          events.push(`${name}:lock`);
          return { rows: [] as never[] };
        }
        if (text === 'SELECT pg_advisory_unlock($1)') {
          holder = null;
          events.push(`${name}:unlock`);
          waiters.splice(0).forEach((resolve) => resolve());
          return { rows: [] as never[] };
        }
        if (text.startsWith('SELECT version, checksum')) {
          return {
            rows: [...recorded].map(([version, checksum]) => ({
              version,
              checksum,
            })) as never[],
          };
        }
        if (text.startsWith('INSERT INTO public.schema_migrations')) {
          const [version, checksum] = values as [string, string];
          recorded.set(version, checksum);
        }
        if (text.startsWith('CREATE TABLE')) {
          events.push(`${name}:${text}`);
        }
        return { rows: [] as never[] };
      },
    });

    const [first, second] = await Promise.all([
      runSelfhostMigrations(sessionFor('one'), options()),
      runSelfhostMigrations(sessionFor('two'), options()),
    ]);

    expect(first.applied.length + second.applied.length).toBe(2);
    // Each session's DDL sits strictly between its own lock and unlock.
    const owner = events
      .filter((event) => event.endsWith(':lock'))
      .map((e) => e.split(':')[0]);
    expect(owner).toHaveLength(2);
    let depth = 0;
    for (const event of events) {
      if (event.endsWith(':lock')) depth += 1;
      if (event.endsWith(':unlock')) depth -= 1;
      if (event.includes('CREATE TABLE')) expect(depth).toBe(1);
      expect(depth).toBeLessThanOrEqual(1);
    }
  });
});

describe('resolveSelfhostAssetPaths', () => {
  it('finds the repository assets from the source tree', () => {
    const paths = resolveSelfhostAssetPaths(
      join(repositoryRoot, 'src', 'scripts'),
    );

    expect(paths.migrationsDir).toBe(migrationsDir);
    expect(paths.bootstrapSqlPath).toBe(bootstrapSqlPath);
  });

  it('finds the same assets from the compiled dist layout', () => {
    const paths = resolveSelfhostAssetPaths(
      join(repositoryRoot, 'dist', 'src', 'scripts'),
    );

    expect(paths.migrationsDir).toBe(migrationsDir);
  });

  it('fails clearly when no migrations tree is above the start directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'selfhost-nothing-'));
    try {
      expect(() => resolveSelfhostAssetPaths(root)).toThrow(
        /Could not find supabase\/migrations/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
