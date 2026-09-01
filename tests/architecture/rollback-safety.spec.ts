import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('database rollback safety', () => {
  it('fails closed before collapsing branch-scoped environment values', () => {
    const rollback = readFileSync(
      resolve(
        __dirname,
        '../../supabase/rollbacks/20260824000000_branch_scoped_env_vars_down.sql',
      ),
      'utf8',
    );
    const preflight = rollback.indexOf('RAISE EXCEPTION');
    const previewMutation = rollback.indexOf("SET environment = 'uat'");
    const transactionStart = rollback.indexOf('BEGIN;');
    const transactionEnd = rollback.lastIndexOf('COMMIT;');

    expect(transactionStart).toBeGreaterThan(-1);
    expect(transactionEnd).toBeGreaterThan(transactionStart);
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(previewMutation);
    expect(rollback).toContain("WHERE environment = 'preview'");
    expect(rollback).not.toContain('GROUP BY deployment_target_id, key');
    expect(rollback).not.toContain('HAVING COUNT(*) > 1');
    expect(rollback).toContain('preview branch identity would be discarded');
    expect(rollback).not.toContain('LOSSY');
    expect(rollback).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
