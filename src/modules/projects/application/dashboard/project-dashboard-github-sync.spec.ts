import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectDashboardService } from './project-dashboard.service';

describe('ProjectDashboardService audit, GitHub sync', () => {
  const row = { id: 'repo-1', repo_full_name: 'o/r' };
  const build = (syncResult: unknown) => {
    const syncIfDue = jest.fn().mockResolvedValue(syncResult);
    const listProjectEvents = jest
      .fn()
      .mockResolvedValue({ enabled: true, items: [], next: null });
    const service = new ProjectDashboardService(
      {
        findByIdAndUser: jest.fn().mockResolvedValue(row),
      } as unknown as ProjectsRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { listProjectEvents },
      undefined,
      undefined,
      undefined,
      { syncIfDue } as never,
    );
    return { service, syncIfDue, listProjectEvents };
  };

  it('syncs before reading the first page and reports githubSync', async () => {
    const { service, syncIfDue } = build({
      status: 'stale',
      syncedAt: 't',
      ingested: null,
    });

    const result = await service.listProjectAuditEvents(
      'repo-1',
      'u',
      {},
      'oauth',
    );

    expect(syncIfDue).toHaveBeenCalledWith(row, 'u', 'oauth');
    expect(result.githubSync).toEqual({ status: 'stale', syncedAt: 't' });
  });

  it('does not sync older pages', async () => {
    const { service, syncIfDue } = build(null);

    const result = await service.listProjectAuditEvents('repo-1', 'u', {
      before: '2026-10-01T10:00:00.000000Z',
    });

    expect(syncIfDue).not.toHaveBeenCalled();
    expect(result.githubSync).toBeUndefined();
  });

  it('omits githubSync when recording is off', async () => {
    const { service } = build(null);

    const result = await service.listProjectAuditEvents('repo-1', 'u');

    expect('githubSync' in result).toBe(false);
  });
});
