import type { DatabaseService } from '#kernel/db/database.service';
import {
  QaProjectRunsRepository,
  tallyVerificationByRequirement,
} from './qa-project-runs.repository';

function build(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  const repository = new QaProjectRunsRepository({
    query,
  } as unknown as DatabaseService);
  return { query, repository };
}

describe('QaProjectRunsRepository.findLatestRunHeadlines', () => {
  it('is one query for every Project: newest run first per Project, active sign-off joined', async () => {
    const { query, repository } = build([
      {
        delivery_project_id: 'dp-1',
        run_id: 'run-2',
        status: 'signed_off',
        created_at: '2026-10-02T00:00:00.000000Z',
        verdict: 'APPROVED',
        signed_at: '2026-10-03T08:00:00.000000Z',
        signed_by_login: 'qa-lead',
      },
      {
        delivery_project_id: 'dp-2',
        run_id: 'run-9',
        status: 'open',
        created_at: '2026-10-05T00:00:00.000000Z',
        verdict: null,
        signed_at: null,
        signed_by_login: null,
      },
    ]);

    // The Iteration ids (each Project's current one), not the Project ids.
    const headlines = await repository.findLatestRunHeadlines([
      'it-1',
      'it-2',
      'it-3',
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DISTINCT ON (r.delivery_project_id)');
    expect(sql).toContain('r.iteration_id = ANY($1::uuid[])');
    expect(sql).not.toContain('r.delivery_project_id = ANY');
    expect(sql).toContain("r.scope = 'project'");
    // Same tie-break as findNewestProjectRun.
    expect(sql).toContain(
      'ORDER BY r.delivery_project_id, r.created_at DESC, r.id DESC',
    );
    // Only the ACTIVE sign-off: a reopened run's old verdict must not show.
    expect(sql).toContain('s.superseded_at IS NULL');
    expect(params).toEqual([['it-1', 'it-2', 'it-3']]);

    expect([...headlines.keys()]).toEqual(['dp-1', 'dp-2']);
    expect(headlines.get('dp-1')).toEqual({
      deliveryProjectId: 'dp-1',
      runId: 'run-2',
      status: 'signed_off',
      createdAt: '2026-10-02T00:00:00.000000Z',
      verdict: 'APPROVED',
      signedAt: '2026-10-03T08:00:00.000000Z',
      signedByLogin: 'qa-lead',
    });
    expect(headlines.get('dp-2')).toMatchObject({
      status: 'open',
      verdict: null,
      signedAt: null,
      signedByLogin: null,
    });
  });

  it('asks nothing for no Projects', async () => {
    const { query, repository } = build();

    expect((await repository.findLatestRunHeadlines([])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('QaProjectRunsRepository.listItemFactsByRunIds', () => {
  it('is one query for every run, grouped by run', async () => {
    const { query, repository } = build([
      {
        run_id: 'run-1',
        source_item_id: 'item-1',
        requirement_id: 'req-1',
        status: 'failed',
        defect_severity: 'major',
      },
      {
        run_id: 'run-1',
        source_item_id: null,
        requirement_id: null,
        status: 'pending',
        defect_severity: null,
      },
      {
        run_id: 'run-2',
        source_item_id: 'item-9',
        requirement_id: 'req-9',
        status: 'passed',
        defect_severity: null,
      },
    ]);

    const facts = await repository.listItemFactsByRunIds(['run-1', 'run-2']);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([['run-1', 'run-2']]);
    expect(facts.get('run-1')).toEqual([
      {
        runId: 'run-1',
        sourceItemId: 'item-1',
        requirementId: 'req-1',
        status: 'failed',
        defectSeverity: 'major',
      },
      {
        runId: 'run-1',
        sourceItemId: null,
        requirementId: null,
        status: 'pending',
        defectSeverity: null,
      },
    ]);
    expect(facts.get('run-2')).toHaveLength(1);
  });

  it('asks nothing for no runs', async () => {
    const { query, repository } = build();

    expect((await repository.listItemFactsByRunIds([])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('tallyVerificationByRequirement', () => {
  it('counts per requirement, folds a legacy in_progress into pending, keeps a deleted requirement under null', () => {
    const counts = tallyVerificationByRequirement([
      { requirementId: 'req-1', status: 'passed' },
      { requirementId: 'req-1', status: 'passed' },
      { requirementId: 'req-1', status: 'in_progress' },
      { requirementId: 'req-1', status: 'returned_to_dev' },
      { requirementId: null, status: 'failed' },
    ]);

    expect(counts.get('req-1')).toEqual({
      pending: 1,
      passed: 2,
      failed: 0,
      blocked: 0,
      returned_to_dev: 1,
    });
    expect(counts.get(null)).toEqual({
      pending: 0,
      passed: 0,
      failed: 1,
      blocked: 0,
      returned_to_dev: 0,
    });
  });
});

describe('QaProjectRunsRepository is scoped by Iteration, not by Project (P3)', () => {
  const sqlOf = (query: jest.Mock) => query.mock.calls[0]?.[0] as string;

  it.each([
    [
      'findRunByFingerprint',
      (r: QaProjectRunsRepository) => r.findRunByFingerprint('it-1', 'fp'),
      ['it-1', 'fp'],
    ],
    [
      'listProjectRuns',
      (r: QaProjectRunsRepository) =>
        r.listProjectRuns('it-1', { limit: 10, cursor: null }),
      ['it-1', 10],
    ],
    [
      'findNewestProjectRun',
      (r: QaProjectRunsRepository) =>
        r.findNewestProjectRun('it-1', { openOnly: true }),
      ['it-1', true],
    ],
    [
      'findReturnedOpenRunItems',
      (r: QaProjectRunsRepository) =>
        r.findReturnedOpenRunItems('it-1', 'item-1'),
      ['it-1', 'item-1'],
    ],
  ])('%s filters on iteration_id', async (_name, call, params) => {
    const { query, repository } = build();

    await call(repository);

    expect(sqlOf(query)).toContain('iteration_id = $1');
    expect(sqlOf(query)).not.toContain('delivery_project_id = $1');
    expect(query.mock.calls[0]?.[1]).toEqual(params);
  });

  it('findLatestSignedOff filters the sign-off join on the run Iteration', async () => {
    const { query, repository } = build();

    expect(await repository.findLatestSignedOff('it-1')).toBeNull();

    expect(sqlOf(query)).toContain('r.iteration_id = $1');
    expect(query.mock.calls[0]?.[1]).toEqual(['it-1']);
  });

  it('findProjectRun still addresses a run by id within its Project, so a delivered Iteration run stays readable', async () => {
    const { query, repository } = build();

    await repository.findProjectRun('dp-1', 'run-1');

    expect(sqlOf(query)).toContain('delivery_project_id = $2');
    expect(sqlOf(query)).not.toContain('iteration_id');
  });
});

describe('QaProjectRunsRepository.createRun (P1: the key is (Iteration, heads))', () => {
  const input = {
    deliveryProjectId: 'dp-1',
    iterationId: 'it-2',
    projectName: 'Checkout',
    headsFingerprint: 'f'.repeat(64),
    repositories: [],
    createdBy: 'qa-1',
    createdByLogin: 'qa',
    items: [],
  };

  it('stores the Iteration and conflicts on (iteration_id, heads_fingerprint)', async () => {
    const run = { id: 'run-new', iteration_id: 'it-2' };
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [run] }) // INSERT ... RETURNING
      .mockResolvedValue({ rows: [] }); // prior-run lookup
    const repository = new QaProjectRunsRepository({
      withTransaction: (fn: (c: { query: jest.Mock }) => unknown) =>
        fn({ query }),
    } as unknown as DatabaseService);

    const result = await repository.createRun(input);

    expect(result.created).toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('iteration_id');
    expect(sql).toContain(
      "ON CONFLICT (iteration_id, heads_fingerprint) WHERE scope = 'project'",
    );
    expect(params).toContain('it-2');
    // The previous run to link items to is the Iteration's, not the Project's.
    const [priorSql, priorParams] = query.mock.calls[1] as [string, unknown[]];
    expect(priorSql).toContain('iteration_id = $1');
    expect(priorParams).toEqual(['it-2', 'run-new']);
  });

  it('on a conflict returns the existing run of the SAME Iteration', async () => {
    const existing = { id: 'run-old', iteration_id: 'it-2' };
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // INSERT conflicted
      .mockResolvedValueOnce({ rows: [existing] }) // SELECT existing
      .mockResolvedValue({ rows: [] }); // items, coverage
    const repository = new QaProjectRunsRepository({
      withTransaction: (fn: (c: { query: jest.Mock }) => unknown) =>
        fn({ query }),
    } as unknown as DatabaseService);

    const result = await repository.createRun(input);

    expect(result).toMatchObject({ created: false, run: existing });
    const [selectSql, selectParams] = query.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(selectSql).toContain('iteration_id = $1 AND heads_fingerprint = $2');
    expect(selectParams).toEqual(['it-2', input.headsFingerprint]);
  });
});

describe('QaProjectRunsRepository.countIterationItemsNotPassed', () => {
  it("counts the Iteration's active items with no PASSED row in the run", async () => {
    const { query, repository } = build([{ n: 2 }]);

    await expect(
      repository.countIterationItemsNotPassed('it-2', 'run-7'),
    ).resolves.toBe(2);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('c.iteration_id = $1');
    expect(sql).toContain('c.archived_at IS NULL');
    expect(sql).toContain('ri.run_id = $2');
    expect(sql).toContain("ri.status = 'passed'");
    expect(params).toEqual(['it-2', 'run-7']);
  });

  it('is 0 when the query returns no row', async () => {
    const { repository } = build([]);

    await expect(
      repository.countIterationItemsNotPassed('it-2', 'run-7'),
    ).resolves.toBe(0);
  });
});

describe('QaProjectRunsRepository.appendMissingItemsToOpenRuns', () => {
  function withClient(openRunIds: string[], rowCounts: number[]) {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: openRunIds.map((id) => ({ id })) });
    for (const rowCount of rowCounts) {
      clientQuery.mockResolvedValueOnce({ rows: [], rowCount });
    }
    const withTransaction = jest.fn(
      (work: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
        work({ query: clientQuery }),
    );
    const repository = new QaProjectRunsRepository({
      query: jest.fn(),
      withTransaction,
    } as unknown as DatabaseService);
    return { clientQuery, repository };
  }

  it('locks every open Project run of the Iteration and appends the items it lacks, after its last position', async () => {
    const { clientQuery, repository } = withClient(['run-1', 'run-2'], [2, 0]);

    await expect(repository.appendMissingItemsToOpenRuns('it-3')).resolves.toBe(
      2,
    );

    const [lockSql, lockParams] = clientQuery.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(lockSql).toContain("status = 'open'");
    expect(lockSql).toContain('FOR UPDATE');
    expect(lockParams).toEqual(['it-3']);

    const [insertSql, insertParams] = clientQuery.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(insertSql).toContain('INSERT INTO projects.qa_run_items');
    expect(insertSql).toContain('COALESCE(MAX("position"), -1)');
    expect(insertSql).toContain('c.archived_at IS NULL');
    expect(insertSql).toContain('ri.source_item_id = i.id');
    expect(insertParams).toEqual(['run-1', 'it-3']);
    expect((clientQuery.mock.calls[2] as [string, unknown[]])[1]).toEqual([
      'run-2',
      'it-3',
    ]);
  });

  it('does nothing without an open run', async () => {
    const { clientQuery, repository } = withClient([], []);

    await expect(repository.appendMissingItemsToOpenRuns('it-3')).resolves.toBe(
      0,
    );
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });
});
