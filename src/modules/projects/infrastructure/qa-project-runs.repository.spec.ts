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

    const headlines = await repository.findLatestRunHeadlines([
      'dp-1',
      'dp-2',
      'dp-3',
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DISTINCT ON (r.delivery_project_id)');
    expect(sql).toContain('r.delivery_project_id = ANY($1::uuid[])');
    expect(sql).toContain("r.scope = 'project'");
    // Same tie-break as findNewestProjectRun.
    expect(sql).toContain(
      'ORDER BY r.delivery_project_id, r.created_at DESC, r.id DESC',
    );
    // Only the ACTIVE sign-off: a reopened run's old verdict must not show.
    expect(sql).toContain('s.superseded_at IS NULL');
    expect(params).toEqual([['dp-1', 'dp-2', 'dp-3']]);

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
