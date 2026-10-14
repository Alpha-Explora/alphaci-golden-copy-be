import type { DatabaseService } from '#kernel/db/database.service';
import { ProjectIterationsRepository } from './project-iterations.repository';

function build(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  const repository = new ProjectIterationsRepository({
    query,
  } as unknown as DatabaseService);
  return { query, repository };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'it-1',
  delivery_project_id: 'dp-1',
  number: 1,
  status: 'active',
  ...overrides,
});

describe('ProjectIterationsRepository', () => {
  it('findCurrent prefers the active Iteration, else the highest number', async () => {
    const { query, repository } = build([row()]);

    expect(await repository.findCurrent('dp-1')).toEqual(row());

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ORDER BY (status = 'active') DESC, number DESC");
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual(['dp-1']);
  });

  it('findCurrent is null for a Project with no Iteration', async () => {
    expect(await build().repository.findCurrent('dp-1')).toBeNull();
  });

  it('list is newest first', async () => {
    const { query, repository } = build([row({ number: 2 }), row()]);

    await repository.list('dp-1');

    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY number DESC');
  });

  it('insertFirstIfNone is one race-safe statement that creates Iteration 1 only where there is none', async () => {
    const { query, repository } = build();

    await repository.insertFirstIfNone(['dp-1', 'dp-2']);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SELECT p.id, 1, 'active'");
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(params).toEqual([['dp-1', 'dp-2']]);
  });

  it('asks nothing when there is nothing to create or resolve', async () => {
    const { query, repository } = build();

    await repository.insertFirstIfNone([]);
    expect((await repository.findCurrentByDeliveryProjects([])).size).toBe(0);

    expect(query).not.toHaveBeenCalled();
  });

  it('findCurrentByDeliveryProjects resolves every Project in one query, keyed by Project', async () => {
    const { query, repository } = build([
      row(),
      row({ id: 'it-9', delivery_project_id: 'dp-2', number: 3 }),
    ]);

    const map = await repository.findCurrentByDeliveryProjects([
      'dp-1',
      'dp-2',
      'dp-3',
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DISTINCT ON (delivery_project_id)');
    expect(sql).toContain(
      "ORDER BY delivery_project_id, (status = 'active') DESC, number DESC",
    );
    expect(params).toEqual([['dp-1', 'dp-2', 'dp-3']]);
    expect([...map.keys()]).toEqual(['dp-1', 'dp-2']);
    expect(map.get('dp-2')?.id).toBe('it-9');
  });

  it('recordRepositoryDelivery is ONE guarded UPDATE: active only, same-head entry kept, older-head entry replaced', async () => {
    const { query, repository } = build([row()]);
    const entry = {
      projectId: 'p-api',
      repoFullName: 'acme/api',
      uatHeadSha: 'a'.repeat(40),
      how: 'merged',
    };

    expect(await repository.recordRepositoryDelivery('it-1', entry)).toEqual(
      row(),
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE projects.project_iterations');
    expect(sql).toContain("WHERE i.id = $1 AND i.status = 'active'");
    expect(sql).toContain("e->>'projectId' = $2 AND e->>'uatHeadSha' <> $3");
    expect(sql).toContain("e->>'projectId' = $2 AND e->>'uatHeadSha' = $3");
    expect(sql).toContain('RETURNING i.*');
    expect(params).toEqual([
      'it-1',
      'p-api',
      'a'.repeat(40),
      JSON.stringify(entry),
    ]);
  });

  it('recordRepositoryDelivery is null once the Iteration is no longer active', async () => {
    const { repository } = build([]);

    expect(
      await repository.recordRepositoryDelivery('it-1', {
        projectId: 'p',
        uatHeadSha: 's',
      }),
    ).toBeNull();
  });

  it('markDelivered is the atomic transition: only an ACTIVE row changes, and only that caller gets it back', async () => {
    const winner = build([row({ status: 'delivered' })]);
    const loser = build([]);
    const input = {
      deliveredBy: 'lead-1',
      deliveredByLogin: 'lead',
      signoffRunId: 'run-1',
      deliveryJson: { repositories: [] },
    };

    expect(await winner.repository.markDelivered('it-1', input)).toEqual(
      row({ status: 'delivered' }),
    );
    expect(await loser.repository.markDelivered('it-1', input)).toBeNull();

    const [sql, params] = winner.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'delivered'");
    expect(sql).toContain('delivered_at = NOW()');
    expect(sql).toContain("WHERE id = $1 AND status = 'active'");
    expect(sql).toContain('RETURNING *');
    expect(params).toEqual([
      'it-1',
      'lead-1',
      'lead',
      'run-1',
      JSON.stringify({ repositories: [] }),
    ]);
  });
});

describe('ProjectIterationsRepository.startNext', () => {
  function transaction(
    responses: Array<{ rows?: unknown[]; rowCount?: number } | Error>,
  ) {
    const query = jest.fn();
    for (const response of responses) {
      if (response instanceof Error) {
        query.mockRejectedValueOnce(response);
      } else {
        query.mockResolvedValueOnce({ rows: [], ...response });
      }
    }
    const withTransaction = jest.fn(
      async (fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
        fn({ query }),
    );
    const repository = new ProjectIterationsRepository({
      withTransaction,
    } as unknown as DatabaseService);
    return { query, repository, withTransaction };
  }

  const input = {
    deliveryProjectId: 'dp-1',
    startedBy: 'lead-1',
    startedByLogin: 'lead',
    goal: 'Loyalty',
    itemIds: ['i-1', 'i-2', 'i-3'],
    signoffRunId: 'run-1',
  };

  it('creates the Iteration and copies the items in ONE transaction', async () => {
    const { query, repository, withTransaction } = transaction([
      { rows: [row({ id: 'it-2', number: 2 })] },
      { rows: [{ id: 'req-a' }, { id: 'req-b' }] },
      {},
      { rowCount: 3 },
    ]);

    const result = await repository.startNext(input);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      iteration: { id: 'it-2', number: 2 },
      carriedRequirements: 2,
      carriedItems: 3,
    });

    const [iterationSql, iterationParams] = query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(iterationSql).toContain('COALESCE(MAX(number), 0) + 1');
    expect(iterationSql).toContain("'active'");
    expect(iterationParams).toEqual(['dp-1', 'Loyalty', 'lead-1', 'lead']);
  });

  it('copies by INSERT ... SELECT only: no source row is updated or deleted', async () => {
    const { query, repository } = transaction([
      { rows: [row({ id: 'it-2', number: 2 })] },
      { rows: [{ id: 'req-a' }] },
      {},
      { rowCount: 3 },
    ]);

    await repository.startNext(input);

    const statements = query.mock.calls.map(([sql]) => sql as string);
    for (const sql of statements) {
      expect(sql).not.toContain('UPDATE ');
      expect(sql).not.toContain('DELETE ');
    }
    expect(statements[2]).toContain('INSERT INTO projects.qa_checklists');
    expect(statements[2]).toContain('c.kind');
    expect(statements[2]).toContain('c.name');
    expect(statements[3]).toContain('INSERT INTO projects.qa_checklist_items');
    // Order is kept, renumbered 0..n-1 per new requirement.
    expect(statements[3]).toContain('row_number() OVER');
    expect(statements[3]).toContain('ORDER BY i."position", i.id');
  });

  it('resets progress to in_progress only for failed, blocked and returned_to_dev items of the delivering run', async () => {
    const { query, repository } = transaction([
      { rows: [row({ id: 'it-2', number: 2 })] },
      { rows: [{ id: 'req-a' }] },
      {},
      { rowCount: 3 },
    ]);

    await repository.startNext(input);

    const [sql, params] = query.mock.calls[3] as [string, unknown[]];
    expect(sql).toContain(
      "CASE WHEN r.reset THEN 'in_progress' ELSE i.progress END",
    );
    expect(sql).toContain('ri.run_id = $4');
    expect(sql).toContain('ri.source_item_id = i.id');
    expect(sql).toContain('ri.status = ANY($5::text[])');
    expect(params[2]).toEqual(['i-1', 'i-2', 'i-3']);
    expect(params[3]).toBe('run-1');
    expect(params[4]).toEqual(['failed', 'blocked', 'returned_to_dev']);
    // Every new requirement id is distinct and paired with its source.
    const [oldIds, newIds] = params as [string[], string[]];
    expect(oldIds).toEqual(['req-a']);
    expect(new Set(newIds).size).toBe(newIds.length);
    expect(newIds).not.toContain('req-a');
  });

  it('a start with no items writes only the Iteration', async () => {
    const { query, repository } = transaction([
      { rows: [row({ id: 'it-2', number: 2 })] },
    ]);

    const result = await repository.startNext({ ...input, itemIds: [] });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ carriedRequirements: 0, carriedItems: 0 });
  });

  it('a unique violation from the one-active index surfaces untouched, so the transaction rolls back', async () => {
    const violation = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });
    const { query, repository } = transaction([violation]);

    await expect(repository.startNext(input)).rejects.toBe(violation);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('listCarryOverItems reads the active requirements of ONE Iteration with the delivering run status', async () => {
    const { query, repository } = build([]);

    await repository.listCarryOverItems('it-1', 'run-1');

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('c.iteration_id = $1');
    expect(sql).toContain('c.archived_at IS NULL');
    expect(sql).toContain('ri.run_id = $2');
    expect(params).toEqual(['it-1', 'run-1']);
  });
});
