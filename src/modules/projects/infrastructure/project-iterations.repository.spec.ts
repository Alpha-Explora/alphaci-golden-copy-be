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
