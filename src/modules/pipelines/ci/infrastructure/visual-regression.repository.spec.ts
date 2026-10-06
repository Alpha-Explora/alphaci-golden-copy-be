import type { DatabaseService } from '#kernel/db/database.service';
import {
  VISUAL_RUN_RETENTION,
  VisualRegressionRepository,
} from './visual-regression.repository';

describe('VisualRegressionRepository', () => {
  let query: jest.Mock;
  let repo: VisualRegressionRepository;
  const key = {
    repoFullName: 'o/r',
    branch: 'uat',
    runId: 5,
    browser: 'chromium',
  };

  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [] });
    repo = new VisualRegressionRepository({
      query,
    } as unknown as DatabaseService);
  });

  it('retains the latest 10 runs per repo and branch, in both result tables, never baselines', async () => {
    expect(VISUAL_RUN_RETENTION).toBe(10);

    await repo.pruneRuns('o/r', 'uat');

    expect(query).toHaveBeenCalledTimes(2);
    const calls = query.mock.calls as [string, unknown[]][];
    const images = calls[0]?.[0];
    const snapshots = calls[1]?.[0];
    expect(images).toContain('DELETE FROM workflow.visual_run_images');
    expect(snapshots).toContain('DELETE FROM workflow.visual_run_snapshots');
    for (const [sql, params] of query.mock.calls as [string, unknown[]][]) {
      expect(sql).toContain('ORDER BY run_id DESC LIMIT $3');
      expect(sql).not.toContain('visual_baselines');
      expect(params).toEqual(['o/r', 'uat', 10]);
    }
  });

  it('ignores a report from an earlier attempt than the stored one', async () => {
    query.mockResolvedValueOnce({ rows: [{ attempt: 3 }] });
    await expect(
      repo.replaceSnapshots(key, 'abc', 2, [{ name: 'a.png', status: 'new' }]),
    ).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('replaces the rows of an earlier attempt when a later attempt reports', async () => {
    query.mockResolvedValueOnce({ rows: [{ attempt: 1 }] });
    await expect(
      repo.replaceSnapshots(key, 'abc', 2, [{ name: 'a.png', status: 'new' }]),
    ).resolves.toBe(true);
    expect(query.mock.calls[1]?.[0]).toContain(
      'DELETE FROM workflow.visual_run_snapshots',
    );
    expect(query.mock.calls[2]?.[0]).toContain(
      'INSERT INTO workflow.visual_run_snapshots',
    );
  });

  it('promotes only changed/new actuals in one statement', async () => {
    query.mockResolvedValueOnce({ rows: [{ name: 'a.png' }] });
    await expect(
      repo.promoteActualsToBaselines({
        ...key,
        names: ['a.png'],
        approvedByUserId: 'u1',
        approvedByLogin: 'dev1',
      }),
    ).resolves.toEqual(['a.png']);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("s.status IN ('changed', 'new')");
    expect(sql).toContain("i.kind = 'actual'");
    expect(sql).toContain('ON CONFLICT (repo_full_name, branch, name)');
  });
});
