import type { PoolClient } from 'pg';

import type { DatabaseService } from '#kernel/db/database.service.js';
import {
  PostgresQaAttachmentOrphanSweep,
  QA_ORPHAN_GRACE_SECONDS,
  QA_ORPHAN_SWEEP_BATCH_SIZE,
} from './qa-attachment-orphan-sweep.postgres';

function setup(options: { lockAcquired?: boolean; rowCount?: number } = {}) {
  const query = jest
    .fn()
    .mockResolvedValueOnce({
      rows: [{ acquired: options.lockAcquired ?? true }],
    })
    .mockResolvedValueOnce({ rows: [], rowCount: options.rowCount ?? 0 });
  const client = { query } as unknown as PoolClient;
  const database = {
    withTransaction: jest.fn(async (fn: (c: PoolClient) => unknown) =>
      fn(client),
    ),
  } as unknown as DatabaseService;
  return {
    sweep: new PostgresQaAttachmentOrphanSweep(database),
    database,
    query,
  };
}

describe('PostgresQaAttachmentOrphanSweep', () => {
  it('uses a 1 hour grace period and 500-row batches by default', () => {
    expect(QA_ORPHAN_GRACE_SECONDS).toBe(60 * 60);
    expect(QA_ORPHAN_SWEEP_BATCH_SIZE).toBe(500);
  });

  it('takes a transaction-scoped try-lock before any delete', async () => {
    const { sweep, database, query } = setup({ rowCount: 3 });

    await sweep.sweepOnce();

    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    const [lockSql, lockParams] = query.mock.calls[0] as [string, unknown[]];
    expect(lockSql).toContain('pg_try_advisory_xact_lock');
    expect(lockSql).not.toContain('pg_advisory_lock(');
    expect(lockParams).toEqual(['projects.qa_attachment_objects.orphan_sweep']);
    const [deleteSql] = query.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(
      /^\s*DELETE FROM projects\.qa_attachment_objects/,
    );
  });

  it('deletes only objects past the grace period with no referencing attachment row, capped at the batch size', async () => {
    const { sweep, query } = setup({ rowCount: 3 });

    const deleted = await sweep.sweepOnce(500, 3600);

    const [deleteSql, params] = query.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toContain("INTERVAL '1 second'");
    expect(deleteSql).toContain('NOT EXISTS');
    expect(deleteSql).toContain(
      'FROM projects.qa_run_item_attachments AS attachment',
    );
    expect(deleteSql).toContain('ORDER BY candidate.created_at');
    expect(deleteSql).toContain('LIMIT $2::int');
    expect(params).toEqual([3600, 500]);
    expect(deleted).toBe(3);
  });

  it('deletes nothing and returns null when another replica holds the lock', async () => {
    const { sweep, query } = setup({ lockAcquired: false });

    await expect(sweep.sweepOnce()).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('pg_try_advisory_xact_lock');
  });

  it('reports zero when the batch found no orphans', async () => {
    const { sweep } = setup({ rowCount: 0 });

    await expect(sweep.sweepOnce()).resolves.toBe(0);
  });
});
