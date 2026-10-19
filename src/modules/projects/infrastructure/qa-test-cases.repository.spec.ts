import type { DatabaseService } from '#kernel/db/database.service';
import { QaRunNotOpenError } from './qa-runs.repository';
import {
  QaTestCasesRepository,
  syncOpenRunTestCases,
} from './qa-test-cases.repository';

const actor = { id: 'user-1', login: 'quinn' };

function makeRepository(query: jest.Mock) {
  const databaseService = {
    query,
    withTransaction: jest.fn(
      async (fn: (client: { query: jest.Mock }) => unknown) => fn({ query }),
    ),
  } as unknown as DatabaseService;
  return new QaTestCasesRepository(databaseService);
}

describe('syncOpenRunTestCases', () => {
  it('does nothing when the Iteration has no open run', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });

    await expect(
      syncOpenRunTestCases({ query } as never, 'it-1'),
    ).resolves.toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FOR SHARE');
  });

  it('locks runs, then run items, before it touches a copy, and bumps every story it changed', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ run_item_id: 'ri-1' }] })
      .mockResolvedValueOnce({
        rows: [{ run_item_id: 'ri-1' }, { run_item_id: 'ri-2' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      syncOpenRunTestCases({ query } as never, 'it-1'),
    ).resolves.toBe(2);

    const sql = query.mock.calls.map((call) => call[0] as string);
    expect(sql[0]).toMatch(
      /qa_verification_runs[\s\S]*status = 'open'[\s\S]*FOR SHARE/,
    );
    expect(sql[1]).toMatch(
      /FROM projects\.qa_run_items[\s\S]*ORDER BY ri\.id[\s\S]*FOR UPDATE/,
    );
    expect(sql[2]).toMatch(
      /DELETE FROM projects\.qa_run_test_cases[\s\S]*source_test_case_id IS NULL/,
    );
    expect(sql[3]).toMatch(
      /ON CONFLICT \(run_item_id, source_test_case_id\) DO UPDATE/,
    );
    // An unchanged copy keeps its result and is not rewritten.
    expect(sql[3]).toContain('IS DISTINCT FROM');
    expect(sql[3]).not.toMatch(/SET[\s\S]*status =/);
    expect(sql[4]).toMatch(
      /UPDATE projects\.qa_run_items[\s\S]*row_version = row_version \+ 1/,
    );
    expect(query.mock.calls[4]?.[1]).toEqual([['ri-1', 'ri-2']]);
  });
});

describe('QaTestCasesRepository.recordResult', () => {
  it('locks the run, then the run item, then writes the result, bumps the story and logs an event', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ri-1' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'rtc-1', title: 'Logs in', status: 'failed' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = makeRepository(query);

    const row = await repository.recordResult(
      'run-1',
      'ri-1',
      'rtc-1',
      2,
      { status: 'failed', notes: 'Header empty' },
      actor,
    );

    expect(row?.status).toBe('failed');
    const sql = query.mock.calls.map((call) => call[0] as string);
    expect(sql[0]).toMatch(/qa_verification_runs[\s\S]*FOR SHARE/);
    expect(sql[1]).toMatch(/qa_run_items[\s\S]*FOR UPDATE/);
    expect(sql[3]).toMatch(/UPDATE projects\.qa_run_test_cases/);
    expect(query.mock.calls[3]?.[1]).toEqual([
      'rtc-1',
      'ri-1',
      2,
      'failed',
      true,
      'Header empty',
      'user-1',
      'quinn',
    ]);
    expect(sql[4]).toMatch(/UPDATE projects\.qa_run_items[\s\S]*row_version/);
    expect(sql[5]).toMatch(/INSERT INTO projects\.qa_run_item_events/);
    expect(JSON.parse(query.mock.calls[5]?.[1][4] as string)).toEqual({
      testCase: {
        id: 'rtc-1',
        title: 'Logs in',
        from: 'pending',
        to: 'failed',
        notes: 'Header empty',
      },
    });
  });

  it('refuses a signed-off run without writing', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ status: 'signed_off' }] });
    const repository = makeRepository(query);

    await expect(
      repository.recordResult(
        'run-1',
        'ri-1',
        'rtc-1',
        1,
        { status: 'passed', notes: undefined },
        actor,
      ),
    ).rejects.toBeInstanceOf(QaRunNotOpenError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('answers null for a stale row version, without bumping the story', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ri-1' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = makeRepository(query);

    await expect(
      repository.recordResult(
        'run-1',
        'ri-1',
        'rtc-1',
        9,
        { status: 'passed', notes: undefined },
        actor,
      ),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(4);
  });
});

describe('QaTestCasesRepository definition writes', () => {
  it('re-syncs the open runs in the same transaction as the write', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'cat-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = makeRepository(query);

    await repository.createCategory('item-1', 'Happy path', 'u-1', 'it-1');

    expect(query.mock.calls[0]?.[0]).toMatch(
      /INSERT INTO projects\.qa_test_case_categories/,
    );
    expect(query.mock.calls[1]?.[0]).toMatch(
      /qa_verification_runs[\s\S]*FOR SHARE/,
    );
    expect(query.mock.calls[1]?.[1]).toEqual(['it-1']);
  });

  it('groups categories with their cases, per story, in order', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { id: 'cat-1', item_id: 'item-1', position: 0, name: 'Happy path' },
          { id: 'cat-2', item_id: 'item-1', position: 1, name: 'Session' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'tc-1', category_id: 'cat-1', position: 0, title: 'Logs in' },
        ],
      });
    const repository = makeRepository(query);

    const map = await repository.listByItemIds(['item-1']);

    expect(
      map
        .get('item-1')
        ?.map(({ category, cases }) => [category.id, cases.length]),
    ).toEqual([
      ['cat-1', 1],
      ['cat-2', 0],
    ]);
  });
});
