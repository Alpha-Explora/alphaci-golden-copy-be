import { ProjectDashboardSnapshotsRepository } from './project-dashboard-snapshots.repository';
import type { DatabaseService } from '../../kernel/db/database.service';

const makeDatabaseService = (query: jest.Mock) =>
  ({
    query,
  }) as unknown as DatabaseService;

describe('ProjectDashboardSnapshotsRepository', () => {
  let query: jest.Mock;
  let repository: ProjectDashboardSnapshotsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new ProjectDashboardSnapshotsRepository(
      makeDatabaseService(query),
    );
  });

  it('creates a dashboard snapshot with summary and finding JSON', async () => {
    const finding = {
      code: 'ci_token_missing',
      severity: 'warning' as const,
      message: 'No project CI token is tracked.',
      source: 'local_snapshot' as const,
    };

    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'snapshot-1',
          project_id: 'project-1',
          status: 'warning',
          summary_json: { mode: 'local_snapshot' },
          findings_json: [finding],
          started_at: '2026-06-12T00:00:00.000Z',
          completed_at: '2026-06-12T00:00:01.000Z',
          created_by: 'user-1',
          created_at: '2026-06-12T00:00:01.000Z',
        },
      ],
    });

    const result = await repository.createSnapshot({
      projectId: 'project-1',
      status: 'warning',
      summary: { mode: 'local_snapshot' },
      findings: [finding],
      startedAt: '2026-06-12T00:00:00.000Z',
      completedAt: '2026-06-12T00:00:01.000Z',
      createdBy: 'user-1',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO projects.project_dashboard_snapshots',
      ),
      [
        'project-1',
        'warning',
        JSON.stringify({ mode: 'local_snapshot' }),
        JSON.stringify([finding]),
        '2026-06-12T00:00:00.000Z',
        '2026-06-12T00:00:01.000Z',
        'user-1',
      ],
    );
    expect(result).toMatchObject({
      id: 'snapshot-1',
      projectId: 'project-1',
      status: 'warning',
      findings: [{ code: 'ci_token_missing' }],
    });
  });

  it('finds the latest snapshot for a project', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'snapshot-1',
          project_id: 'project-1',
          status: 'ok',
          summary_json: { mode: 'local_snapshot' },
          findings_json: [],
          started_at: '2026-06-12T00:00:00.000Z',
          completed_at: '2026-06-12T00:00:01.000Z',
          created_by: 'user-1',
          created_at: '2026-06-12T00:00:01.000Z',
        },
      ],
    });

    const result = await repository.findLatestByProject('project-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY created_at DESC'),
      ['project-1'],
    );
    expect(result).toMatchObject({
      id: 'snapshot-1',
      projectId: 'project-1',
      status: 'ok',
    });
  });
});
