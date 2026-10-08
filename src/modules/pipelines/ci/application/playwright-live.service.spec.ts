import type { PlaywrightProgressBodyDto } from '../api/dto/playwright-progress.dto';
import type {
  PlaywrightLiveRepository,
  PlaywrightLiveRunRow,
  PlaywrightLiveTestFinishRow,
  PlaywrightLiveTestKey,
  PlaywrightLiveTestRow,
  PlaywrightLiveTestStartRow,
} from '../infrastructure/playwright-live.repository';
import { PlaywrightLiveService } from './playwright-live.service';
import { PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN } from './playwright-live.rules';

/**
 * An in-memory stand-in with the real repository's upsert semantics (the SQL
 * itself is covered in the repository spec), so idempotency is tested at the
 * level a resend actually happens: whole batches through the service.
 */
class FakeRepository {
  run: (PlaywrightLiveRunRow & { repo: string }) | null = null;
  tests = new Map<string, PlaywrightLiveTestRow>();
  pruned: Array<[string, string]> = [];

  upsertRun = jest.fn(
    (key: {
      repoFullName: string;
      branch: string;
      runId: number;
      runAttempt: number;
      commitSha: string;
    }) => {
      this.run ??= {
        pk: 'run-1',
        repo: key.repoFullName,
        branch: key.branch,
        runId: key.runId,
        runAttempt: key.runAttempt,
        commitSha: key.commitSha,
        status: 'running',
        total: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: '2026-10-08T10:00:00.000Z',
      };
      return Promise.resolve('run-1');
    },
  );
  markRunStarted = jest.fn((_pk: string, total: number, at: string) => {
    this.run!.total = total;
    this.run!.startedAt ??= at;
    return Promise.resolve();
  });
  markRunFinished = jest.fn(
    (_pk: string, status: string, _summary: unknown, at: string) => {
      this.run!.status = status as PlaywrightLiveRunRow['status'];
      this.run!.finishedAt = at;
      return Promise.resolve();
    },
  );
  countTests = jest.fn(() => Promise.resolve(this.tests.size));
  listTestKeys = jest.fn(
    (): Promise<PlaywrightLiveTestKey[]> =>
      Promise.resolve(
        [...this.tests.values()].map((row) => ({
          testKey: row.testKey,
          project: row.project,
          retry: row.retry,
        })),
      ),
  );
  upsertTestStarts = jest.fn(
    (_pk: string, rows: PlaywrightLiveTestStartRow[]) => {
      for (const row of rows) {
        const key = this.k(row);
        const existing = this.tests.get(key);
        this.tests.set(
          key,
          existing
            ? { ...existing, startedAt: existing.startedAt ?? row.startedAt }
            : {
                testKey: row.testKey,
                file: row.file,
                title: row.title,
                project: row.project,
                retry: row.retry,
                status: 'running',
                durationMs: null,
                error: null,
                startedAt: row.startedAt,
                finishedAt: null,
              },
        );
      }
      return Promise.resolve();
    },
  );
  upsertTestFinishes = jest.fn(
    (_pk: string, rows: PlaywrightLiveTestFinishRow[]) => {
      for (const row of rows) {
        const key = this.k(row);
        const existing = this.tests.get(key);
        this.tests.set(key, {
          testKey: row.testKey,
          file: row.file,
          title: row.title,
          project: row.project,
          retry: row.retry,
          status: row.status,
          durationMs: row.durationMs,
          error: row.error,
          startedAt: existing?.startedAt ?? null,
          finishedAt: row.finishedAt,
        });
      }
      return Promise.resolve();
    },
  );
  pruneRuns = jest.fn((repo: string, branch: string) => {
    this.pruned.push([repo, branch]);
    return Promise.resolve();
  });
  findLatestRun = jest.fn(() => Promise.resolve(this.run));
  listTests = jest.fn(() => {
    const rows = [...this.tests.values()];
    rows.sort((a, b) =>
      (a.finishedAt ?? a.startedAt ?? '').localeCompare(
        b.finishedAt ?? b.startedAt ?? '',
      ),
    );
    return Promise.resolve(rows);
  });

  private k(row: { testKey: string; project: string; retry: number }) {
    return `${row.testKey}|${row.project}|${String(row.retry)}`;
  }
}

const base = {
  repoFullName: 'o/r',
  branch: 'uat',
  runId: 99,
  runAttempt: 1,
  commitSha: 'a'.repeat(40),
};
const ident = (id: string, project = 'chromium') => ({
  id,
  file: `${id}.spec.ts`,
  title: `test ${id}`,
  project,
});
const ev = {
  runStarted: (total: number, at = '2026-10-08T10:00:00.000Z') => ({
    type: 'run_started',
    at,
    total,
  }),
  started: (id: string, at: string, retry?: number) => ({
    type: 'test_started',
    at,
    test: { ...ident(id), ...(retry !== undefined && { retry }) },
  }),
  finished: (
    id: string,
    status: string,
    at: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'test_finished',
    at,
    test: {
      ...ident(id),
      status,
      durationMs: 100,
      retry: 0,
      error: null,
      ...extra,
    },
  }),
  runFinished: (status: string, at: string) => ({
    type: 'run_finished',
    at,
    status,
    summary: { passed: 1, failed: 1, skipped: 0, flaky: 0, durationMs: 5 },
  }),
};
const batch = (...events: unknown[]) =>
  ({ ...base, events }) as unknown as PlaywrightProgressBodyDto;

describe('PlaywrightLiveService', () => {
  let repo: FakeRepository;
  let service: PlaywrightLiveService;

  beforeEach(() => {
    repo = new FakeRepository();
    service = new PlaywrightLiveService(
      repo as unknown as PlaywrightLiveRepository,
    );
  });

  it('answers accepted = events in the batch and prunes retention for that repo+branch', async () => {
    await expect(
      service.ingest(
        'o/r',
        batch(ev.runStarted(2), ev.started('a', '2026-10-08T10:00:01.000Z')),
      ),
    ).resolves.toEqual({ accepted: 2 });
    expect(repo.pruned).toEqual([['o/r', 'uat']]);
  });

  it('aggregates done / passed / failed / skipped / running and orders finished newest last', async () => {
    await service.ingest(
      'o/r',
      batch(
        ev.runStarted(6),
        ev.started('a', '2026-10-08T10:00:01.000Z'),
        ev.started('b', '2026-10-08T10:00:01.500Z'),
        ev.started('c', '2026-10-08T10:00:02.000Z'),
        ev.started('d', '2026-10-08T10:00:02.500Z'),
        ev.finished('a', 'passed', '2026-10-08T10:00:03.000Z'),
        ev.finished('b', 'failed', '2026-10-08T10:00:04.000Z', {
          error: 'boom',
        }),
        ev.finished('c', 'skipped', '2026-10-08T10:00:03.500Z'),
      ),
    );
    const run = await service.getLatestRun('o/r', 'uat');
    expect(run).toMatchObject({
      runId: 99,
      status: 'running',
      total: 6,
      done: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
    });
    expect(run?.running.map((t) => t.id)).toEqual(['d']);
    expect(run?.tests.map((t) => [t.id, t.status])).toEqual([
      ['a', 'passed'],
      ['c', 'skipped'],
      ['b', 'failed'],
    ]);
    expect(run?.tests.at(-1)?.error).toBe('boom');
  });

  it('counts timedOut and interrupted tests as failed', async () => {
    await service.ingest(
      'o/r',
      batch(
        ev.finished('a', 'timedOut', '2026-10-08T10:00:03.000Z'),
        ev.finished('b', 'interrupted', '2026-10-08T10:00:04.000Z'),
      ),
    );
    expect((await service.getLatestRun('o/r', 'uat'))?.failed).toBe(2);
  });

  it('counts a retried test once, by its latest retry', async () => {
    await service.ingest(
      'o/r',
      batch(
        ev.started('a', '2026-10-08T10:00:01.000Z', 0),
        ev.finished('a', 'failed', '2026-10-08T10:00:02.000Z', {
          retry: 0,
          error: 'flake',
        }),
        ev.started('a', '2026-10-08T10:00:03.000Z', 1),
      ),
    );
    let run = await service.getLatestRun('o/r', 'uat');
    expect(run).toMatchObject({ done: 0, failed: 0 });
    expect(run?.running.map((t) => t.id)).toEqual(['a']);

    await service.ingest(
      'o/r',
      batch(
        ev.finished('a', 'passed', '2026-10-08T10:00:04.000Z', { retry: 1 }),
      ),
    );
    run = await service.getLatestRun('o/r', 'uat');
    expect(run).toMatchObject({ done: 1, passed: 1, failed: 0 });
    expect(run?.running).toEqual([]);
  });

  it('is idempotent: re-sending a batch (even after later events) changes nothing', async () => {
    const first = batch(
      ev.runStarted(2),
      ev.started('a', '2026-10-08T10:00:01.000Z'),
      ev.finished('a', 'passed', '2026-10-08T10:00:02.000Z'),
    );
    await service.ingest('o/r', first);
    const before = await service.getLatestRun('o/r', 'uat');
    await service.ingest(
      'o/r',
      batch(ev.started('b', '2026-10-08T10:00:03.000Z')),
    );

    await service.ingest('o/r', first);
    const after = await service.getLatestRun('o/r', 'uat');

    expect(after?.done).toBe(before?.done);
    expect(after?.tests).toEqual(before?.tests);
    // A resent start must not reopen the finished test 'a'.
    expect(after?.running.map((t) => t.id)).toEqual(['b']);
    expect(repo.tests.size).toBe(2);
  });

  it('collapses duplicate events inside one batch (first start, last finish)', async () => {
    await service.ingest(
      'o/r',
      batch(
        ev.started('a', '2026-10-08T10:00:01.000Z'),
        ev.started('a', '2026-10-08T10:00:01.500Z'),
        ev.finished('a', 'failed', '2026-10-08T10:00:02.000Z'),
        ev.finished('a', 'passed', '2026-10-08T10:00:03.000Z'),
      ),
    );
    expect(repo.upsertTestStarts.mock.calls[0]?.[1]).toHaveLength(1);
    expect(repo.upsertTestFinishes.mock.calls[0]?.[1]).toHaveLength(1);
    expect((await service.getLatestRun('o/r', 'uat'))?.passed).toBe(1);
  });

  it('records run_finished status and summary', async () => {
    await service.ingest(
      'o/r',
      batch(
        ev.runStarted(1),
        ev.runFinished('failed', '2026-10-08T10:01:00.000Z'),
      ),
    );
    expect(repo.markRunFinished).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ failed: 1 }),
      '2026-10-08T10:01:00.000Z',
    );
    expect(await service.getLatestRun('o/r', 'uat')).toMatchObject({
      status: 'failed',
      finishedAt: '2026-10-08T10:01:00.000Z',
    });
  });

  it('returns null when the branch has no run', async () => {
    expect(await service.getLatestRun('o/r', 'uat')).toBeNull();
  });

  it('caps finished tests returned at 500, keeping the newest', async () => {
    const events = Array.from({ length: 200 }, (_, i) =>
      ev.finished(
        `t${String(i).padStart(4, '0')}`,
        'passed',
        `2026-10-08T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      ),
    );
    // 4 batches x 200 distinct tests = 800 stored; only 500 returned, the counts cover all 800.
    for (let offset = 0; offset < 4; offset += 1) {
      await service.ingest(
        'o/r',
        batch(
          ...events.map((e) => ({
            ...e,
            test: { ...e.test, id: `${e.test.id}-${String(offset)}` },
            at: e.at.replace('T10', `T1${String(offset)}`),
          })),
        ),
      );
    }
    const run = await service.getLatestRun('o/r', 'uat');
    expect(run?.done).toBe(800);
    expect(run?.tests).toHaveLength(500);
    expect(run?.tests.at(-1)?.id).toMatch(/-3$/);
  });

  it('ignores new tests beyond the per-run cap but still updates stored ones', async () => {
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    for (let i = 0; i < PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN - 1; i += 1) {
      repo.tests.set(`k${String(i)}|chromium|0`, {
        testKey: `k${String(i)}`,
        file: 'f',
        title: 't',
        project: 'chromium',
        retry: 0,
        status: 'running',
        durationMs: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      });
    }
    await service.ingest(
      'o/r',
      batch(
        ev.started('new-1', '2026-10-08T10:00:01.000Z'),
        ev.started('new-2', '2026-10-08T10:00:01.000Z'),
        ev.finished('k0', 'passed', '2026-10-08T10:00:02.000Z'),
      ),
    );
    expect(repo.tests.size).toBe(PLAYWRIGHT_LIVE_MAX_TESTS_PER_RUN);
    expect(repo.tests.has('new-1|chromium|0')).toBe(true);
    expect(repo.tests.has('new-2|chromium|0')).toBe(false);
    expect(repo.tests.get('k0|chromium|0')?.status).toBe('passed');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring 1 test(s)'),
    );
  });
});
