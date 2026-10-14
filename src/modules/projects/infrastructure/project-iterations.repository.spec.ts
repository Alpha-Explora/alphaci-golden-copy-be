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
});
