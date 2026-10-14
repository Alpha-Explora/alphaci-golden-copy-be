import type { DatabaseService } from '#kernel/db/database.service';
import { QaRequirementsRepository } from './qa-requirements.repository';

function build(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  const repository = new QaRequirementsRepository({
    query,
  } as unknown as DatabaseService);
  return { query, repository };
}

/** Every Project-scoped read of requirements is by Iteration (ITERATIONS_PLAN.md P3). */
describe('QaRequirementsRepository is scoped by Iteration', () => {
  it('listActiveByIteration reads the active requirements of one Iteration', async () => {
    const { query, repository } = build([{ id: 'req-1' }]);

    expect(await repository.listActiveByIteration('it-1')).toEqual([
      { id: 'req-1' },
    ]);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE iteration_id = $1 AND archived_at IS NULL');
    expect(params).toEqual(['it-1']);
  });

  it('requirementsChangedSince only looks at the Iteration', async () => {
    const { query, repository } = build([{ changed: true }]);

    expect(
      await repository.requirementsChangedSince('it-1', '2026-10-01T00:00:00Z'),
    ).toBe(true);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('iteration_id = $1 AND updated_at > $2::timestamptz');
    expect(params).toEqual(['it-1', '2026-10-01T00:00:00Z']);
  });

  it('countActiveByIteration counts one Iteration, optionally one kind', async () => {
    const { query, repository } = build([{ n: '3' }]);

    expect(await repository.countActiveByIteration('it-1', 'functional')).toBe(
      3,
    );

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('iteration_id = $1');
    expect(params).toEqual(['it-1', 'functional']);
  });

  it('the team overview keeps unassigned legacy checklists and only the given Iterations of the rest', async () => {
    const { query, repository } = build();

    await repository.listByWorkspace('ws-1', false, ['it-1', 'it-2']);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      '(delivery_project_id IS NULL OR iteration_id = ANY($3::uuid[]))',
    );
    expect(params).toEqual(['ws-1', false, ['it-1', 'it-2']]);
  });
});
