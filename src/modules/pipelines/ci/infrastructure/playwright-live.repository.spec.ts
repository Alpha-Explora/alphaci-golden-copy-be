import type { DatabaseService } from '#kernel/db/database.service';
import { PLAYWRIGHT_LIVE_RUN_RETENTION } from '../application/playwright-live.rules';
import { PlaywrightLiveRepository } from './playwright-live.repository';

describe('PlaywrightLiveRepository', () => {
  let query: jest.Mock;
  let repo: PlaywrightLiveRepository;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [] });
    repo = new PlaywrightLiveRepository({
      query,
    } as unknown as DatabaseService);
  });

  it('retains the latest 10 runs per repo and branch (tests cascade with their run)', async () => {
    expect(PLAYWRIGHT_LIVE_RUN_RETENTION).toBe(10);

    await repo.pruneRuns('o/r', 'uat');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM workflow.playwright_live_runs');
    expect(sql).toContain('ORDER BY run_id DESC, run_attempt DESC');
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual(['o/r', 'uat', 10]);
  });

  it('upserts the run on its natural key so a resend only touches updated_at', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'pk-1' }] });
    await expect(
      repo.upsertRun({
        repoFullName: 'o/r',
        branch: 'uat',
        runId: 7,
        runAttempt: 2,
        commitSha: 'abc1234',
      }),
    ).resolves.toBe('pk-1');
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (repo_full_name, run_id, run_attempt)');
    expect(params).toEqual(['o/r', 'uat', 7, 2, 'abc1234']);
  });

  it('a start never changes the status of a test that already exists', async () => {
    await repo.upsertTestStarts('pk-1', [
      {
        testKey: 't',
        file: 'f',
        title: 'x',
        project: 'chromium',
        retry: 0,
        startedAt: '2026-10-08T10:00:00.000Z',
      },
    ]);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (run_pk, test_key, project, retry)');
    const conflict = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(conflict).toContain('started_at');
    expect(conflict).not.toContain('status');
  });

  it('a finish overwrites status, duration, error and finish time', async () => {
    await repo.upsertTestFinishes('pk-1', [
      {
        testKey: 't',
        file: 'f',
        title: 'x',
        project: 'chromium',
        retry: 0,
        status: 'failed',
        durationMs: 10,
        error: 'boom',
        finishedAt: '2026-10-08T10:00:01.000Z',
      },
    ]);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    const conflict = sql.slice(sql.indexOf('DO UPDATE SET'));
    for (const column of ['status', 'duration_ms', 'error', 'finished_at']) {
      expect(conflict).toContain(column);
    }
  });

  it('skips the query when there is nothing to write', async () => {
    await repo.upsertTestStarts('pk-1', []);
    await repo.upsertTestFinishes('pk-1', []);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the newest run by (run id, attempt) and converts types', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'pk-1',
          branch: 'uat',
          run_id: '123456789',
          run_attempt: 2,
          commit_sha: 'abc',
          status: 'running',
          total: 4,
          started_at: new Date('2026-10-08T10:00:00.000Z'),
          finished_at: null,
          updated_at: new Date('2026-10-08T10:00:05.000Z'),
        },
      ],
    });
    await expect(repo.findLatestRun('o/r', 'uat')).resolves.toEqual({
      pk: 'pk-1',
      branch: 'uat',
      runId: 123456789,
      runAttempt: 2,
      commitSha: 'abc',
      status: 'running',
      total: 4,
      startedAt: '2026-10-08T10:00:00.000Z',
      finishedAt: null,
      updatedAt: '2026-10-08T10:00:05.000Z',
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY run_id DESC, run_attempt DESC');
    expect(params).toEqual(['o/r', 'uat']);
  });
});
