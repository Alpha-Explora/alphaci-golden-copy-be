import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const schemaGate = require(resolve(
  __dirname,
  '../../scripts/check-schema-ownership.cjs',
)) as {
  collectQualifiedReferences: (text: string) => Array<{
    reference: string;
    line: number;
  }>;
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

    expect(references).toEqual([
      { reference: 'identity.app_users', line: 2 },
    ]);
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
});
