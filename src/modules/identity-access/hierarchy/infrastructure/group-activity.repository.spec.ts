import type { DatabaseService } from '#kernel/db/database.service';
import {
  GroupActivityRepository,
  type GroupActivityRow,
} from './group-activity.repository';

const makeDatabaseService = () =>
  ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }) as unknown as DatabaseService;

function queriedCall(db: DatabaseService): [string, unknown[]] {
  return (db.query as jest.Mock).mock.calls[0] as [string, unknown[]];
}

function activityRow(
  overrides: Partial<GroupActivityRow> = {},
): GroupActivityRow {
  return {
    id: 'event-1',
    event_code: 'hierarchy.group.member_added',
    message: 'Member added',
    actor_user_id: 'user-1',
    actor_login: 'alice',
    metadata_json: {},
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

describe('GroupActivityRepository list', () => {
  it('binds groupId, hierarchy.% prefix, and LIMIT 51 by default', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', {});

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = queriedCall(db);
    expect(sql).toContain('event.workspace_id = $1');
    expect(sql).toContain("event.event_code LIKE 'hierarchy.%'");
    expect(sql).toContain('FROM audit.audit_events');
    expect(sql).toContain('ORDER BY event.created_at DESC');
    expect(sql).toContain('LIMIT $2');
    expect(params).toEqual(['group-1', 51]);
  });

  it('sets nextCursor from the last kept created_at when an extra row is returned', async () => {
    const db = makeDatabaseService();
    const extraPage = [
      activityRow({ id: 'event-1', created_at: '2026-09-03T00:00:00Z' }),
      activityRow({ id: 'event-2', created_at: '2026-09-02T00:00:00Z' }),
      activityRow({ id: 'event-3', created_at: '2026-09-01T00:00:00Z' }),
    ];
    (db.query as jest.Mock).mockResolvedValue({ rows: extraPage });
    const repo = new GroupActivityRepository(db);

    const result = await repo.list('group-1', { limit: 2 });

    expect(result.rows).toEqual(extraPage.slice(0, 2));
    expect(result.nextCursor).toBe('2026-09-02T00:00:00Z');
    const [, params] = queriedCall(db);
    expect(params.at(-1)).toBe(3);
  });

  it('returns nextCursor null when the result is not over-fetched', async () => {
    const db = makeDatabaseService();
    const page = [
      activityRow({ id: 'event-1', created_at: '2026-09-03T00:00:00Z' }),
      activityRow({ id: 'event-2', created_at: '2026-09-02T00:00:00Z' }),
    ];
    (db.query as jest.Mock).mockResolvedValue({ rows: page });
    const repo = new GroupActivityRepository(db);

    await expect(repo.list('group-1', { limit: 2 })).resolves.toEqual({
      rows: page,
      nextCursor: null,
    });
  });

  it('clamps limit to 1..200 and fetches one extra row', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', { limit: 0 });
    await repo.list('group-1', { limit: 1000 });

    const lowParams = (db.query as jest.Mock).mock.calls[0][1] as unknown[];
    const highParams = (db.query as jest.Mock).mock.calls[1][1] as unknown[];
    expect(lowParams).toEqual(['group-1', 2]);
    expect(highParams).toEqual(['group-1', 201]);
  });

  it('binds memberId to actor_user_id', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', { memberId: 'user-9' });

    const [sql, params] = queriedCall(db);
    expect(sql).toContain('event.actor_user_id = $2');
    expect(params).toEqual(['group-1', 'user-9', 51]);
  });

  it('binds systemId, deliveryProjectId, and repositoryId from metadata_json', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', {
      systemId: 'sys-1',
      deliveryProjectId: 'dp-1',
      repositoryId: 'repo-1',
    });

    const [sql, params] = queriedCall(db);
    expect(sql).toContain("event.metadata_json ->> 'systemId' = $2");
    expect(sql).toContain("event.metadata_json ->> 'deliveryProjectId' = $3");
    expect(sql).toContain("event.metadata_json ->> 'repositoryId' = $4");
    expect(params).toEqual(['group-1', 'sys-1', 'dp-1', 'repo-1', 51]);
  });

  it('maps activityType assignment to hierarchy.assignment.%', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', { activityType: 'assignment' });

    const [sql, params] = queriedCall(db);
    expect(sql).toContain('event.event_code LIKE $2');
    expect(params).toEqual(['group-1', 'hierarchy.assignment.%', 51]);
  });

  it('maps activityType membership to member_ and invitation_ prefixes', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', { activityType: 'membership' });

    const [sql, params] = queriedCall(db);
    expect(sql).toContain(
      '(event.event_code LIKE $2 OR event.event_code LIKE $3)',
    );
    expect(params).toEqual([
      'group-1',
      'hierarchy.group.member_%',
      'hierarchy.group.invitation_%',
      51,
    ]);
  });

  it('forces FALSE when activityType is github instead of ignoring the filter', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', { activityType: 'github' });

    const [sql, params] = queriedCall(db);
    expect(sql).toContain('AND FALSE');
    expect(sql).not.toContain('event.event_code LIKE $2');
    expect(params).toEqual(['group-1', 51]);
  });

  it('filters dateFrom, dateTo, and cursor on created_at', async () => {
    const db = makeDatabaseService();
    const repo = new GroupActivityRepository(db);

    await repo.list('group-1', {
      dateFrom: '2026-01-01T00:00:00Z',
      dateTo: '2026-12-31T23:59:59Z',
      cursor: '2026-06-01T00:00:00Z',
    });

    const [sql, params] = queriedCall(db);
    expect(sql).toContain('event.created_at >= $2');
    expect(sql).toContain('event.created_at <= $3');
    expect(sql).toContain('event.created_at < $4');
    expect(params).toEqual([
      'group-1',
      '2026-01-01T00:00:00Z',
      '2026-12-31T23:59:59Z',
      '2026-06-01T00:00:00Z',
      51,
    ]);
  });
});
