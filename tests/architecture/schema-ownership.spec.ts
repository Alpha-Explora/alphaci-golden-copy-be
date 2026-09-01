import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const schemaGate = require(
  resolve(__dirname, '../../scripts/check-schema-ownership.cjs'),
) as {
  collectQualifiedReferences: (text: string) => Array<{
    reference: string;
    line: number;
  }>;
  collectSqlReferences: (text: string) => Array<{
    schema: string | null;
    table: string;
    reference: string | null;
    line: number;
  }>;
  resolveKnownUnqualifiedTable: (table: string) => string | null;
  isAllowedReference: (
    owner: string,
    reference: string,
    legacyReferences: Set<string>,
  ) => boolean;
};

describe('schema ownership gate', () => {
  const repositoryRoot = resolve(__dirname, '../..');
  const node = process.execPath;
  const gate = resolve(repositoryRoot, 'scripts/check-schema-ownership.cjs');

  it('checks migrations and inline SQL without blanket file exemptions', () => {
    const result = execFileSync(node, [gate, '--json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const report = JSON.parse(result) as {
      migrations: unknown[];
      source: unknown[];
    };

    expect(report.migrations).toEqual([]);
    expect(report.source).toEqual([]);
    expect(result).toContain('"source"');
  });

  it('recognizes qualified tables inside inline SQL and applies legacy allowances per table', () => {
    const references = schemaGate.collectQualifiedReferences(`
      const query = 'SELECT * FROM identity.app_users';
      // FROM projects.allowed_table is only prose and must not count.
    `);

    expect(references).toEqual([{ reference: 'identity.app_users', line: 2 }]);
    expect(
      schemaGate.isAllowedReference(
        'projects',
        'identity.app_users',
        new Set(['identity.app_users']),
      ),
    ).toBe(true);
    expect(
      schemaGate.isAllowedReference(
        'projects',
        'identity.platform_admins',
        new Set(['identity.app_users']),
      ),
    ).toBe(false);
  });

  it('recognizes schema-qualified DDL targets without treating join predicates as tables', () => {
    const references = schemaGate.collectQualifiedReferences(`
      CREATE INDEX IF NOT EXISTS idx_users_login ON identity.app_users (login);
      CREATE POLICY users_read ON identity.app_users USING (id = auth.uid());
      SELECT * FROM identity.app_users users JOIN projects.provisioned_projects projects ON users.id = projects.user_id;
    `);

    expect(references).toEqual([
      { reference: 'identity.app_users', line: 2 },
      { reference: 'identity.app_users', line: 3 },
      { reference: 'identity.app_users', line: 4 },
      { reference: 'projects.provisioned_projects', line: 4 },
    ]);
  });

  it('resolves only unambiguous unqualified tables instead of trusting a filename exemption', () => {
    const references = schemaGate.collectSqlReferences(`
      const query = 'SELECT * FROM billing_profiles';
      const legacy = 'SELECT * FROM app_users';
    `);

    expect(references).toEqual([
      {
        schema: null,
        table: 'billing_profiles',
        reference: null,
        line: 2,
      },
      {
        schema: null,
        table: 'app_users',
        reference: null,
        line: 3,
      },
    ]);
    expect(schemaGate.resolveKnownUnqualifiedTable('billing_profiles')).toBe(
      'billing',
    );
    // app_users intentionally existed in both the legacy public schema and
    // identity, so the gate refuses to guess which search_path is active.
    expect(schemaGate.resolveKnownUnqualifiedTable('app_users')).toBeNull();
  });
});
