import type { DatabaseService } from '#kernel/db/database.service';
import { AuditEventsRepository } from './audit-events.repository';

describe('AuditEventsRepository, GitHub activity', () => {
  let query: jest.Mock;
  let repository: AuditEventsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new AuditEventsRepository({
      query,
    } as unknown as DatabaseService);
  });

  const event = (n: number) => ({
    externalId: `github:${String(n)}`,
    eventCode: 'github.push',
    message: `Pushed (${String(n)})`,
    metadata: { branch: 'dev' },
    actorLogin: n === 1 ? 'Dev' : null,
    occurredAt: `2026-10-02T10:00:0${String(n)}Z`,
  });

  it('marks rows with a github external id as GitHub-scope', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'event-1',
          workspace_id: 'workspace-1',
          project_id: 'project-1',
          actor_user_id: null,
          actor_login: null,
          external_id: 'github:42',
          event_code: 'github.push',
          message: 'Pushed 3 commits to dev',
          metadata_json: { branch: 'dev' },
          created_at: '2026-10-02T10:00:00.000000Z',
        },
      ],
    });

    const [row] = await repository.listForProject({
      projectId: 'project-1',
      deliveryProjectId: null,
      limit: 10,
      before: null,
    });

    expect(row?.scope).toBe('github');
    const [sql] = query.mock.calls.at(-1) as [string];
    expect(sql).toContain('event.external_id');
  });

  it('inserts the whole batch in one statement, ignoring ids already stored', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });

    await expect(
      repository.insertExternalBatch({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        events: [event(1), event(2), event(3)],
      }),
    ).resolves.toBe(2);

    const [sql, params] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (external_id) DO NOTHING');
    expect(sql).toContain('lower(profile.login) = lower(e.actor_login)');
    expect(params).toEqual([
      'workspace-1',
      'project-1',
      ['github:1', 'github:2', 'github:3'],
      ['github.push', 'github.push', 'github.push'],
      ['Pushed (1)', 'Pushed (2)', 'Pushed (3)'],
      ['Dev', null, null],
      ['{"branch":"dev"}', '{"branch":"dev"}', '{"branch":"dev"}'],
      ['2026-10-02T10:00:01Z', '2026-10-02T10:00:02Z', '2026-10-02T10:00:03Z'],
    ]);
  });

  it('does not touch the database for an empty batch', async () => {
    await expect(
      repository.insertExternalBatch({
        projectId: 'project-1',
        workspaceId: null,
        events: [],
      }),
    ).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('finds which external ids are already stored', async () => {
    query.mockResolvedValueOnce({ rows: [{ external_id: 'github:1' }] });

    await expect(
      repository.findRecordedExternalIds(['github:1', 'github:2']),
    ).resolves.toEqual(new Set(['github:1']));
    await expect(repository.findRecordedExternalIds([])).resolves.toEqual(
      new Set(),
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads and upserts the sync state by lower-case repository name', async () => {
    query.mockResolvedValueOnce({
      rows: [{ etag: 'W/"1"', last_synced_at: '2026-10-02T10:00:00.000Z' }],
    });
    await expect(
      repository.findGithubSyncState('Acme/Orders'),
    ).resolves.toEqual({
      etag: 'W/"1"',
      syncedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(query.mock.calls.at(-1)?.[1]).toEqual(['Acme/Orders']);
    expect(String(query.mock.calls.at(-1)?.[0])).toContain('lower($1)');

    query.mockResolvedValueOnce({ rows: [] });
    await expect(repository.findGithubSyncState('x/y')).resolves.toBeNull();

    query.mockResolvedValueOnce({ rows: [] });
    await repository.saveGithubSyncState('Acme/Orders', {
      etag: 'W/"2"',
      syncedAt: '2026-10-02T10:01:00.000Z',
    });
    const [sql, params] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (repo_full_name) DO UPDATE');
    expect(params).toEqual([
      'Acme/Orders',
      'W/"2"',
      '2026-10-02T10:01:00.000Z',
    ]);
  });
});
