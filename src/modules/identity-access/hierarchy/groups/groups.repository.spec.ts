import type { DatabaseService } from '#kernel/db/database.service';
import { GroupsRepository } from './groups.repository';

const ownerRow = {
  id: 'member-1',
  workspace_id: 'group-1',
  user_id: 'user-1',
  role: 'admin' as const,
  member_status: 'active' as const,
  invited_by: null,
  invited_at: null,
  removed_at: null,
  removed_by: null,
  removal_reason: null,
  created_at: '2026-01-01T00:00:00Z',
  login: 'owner-one',
  display_name: 'Owner',
  email: null,
  avatar_url: null,
};

const makeDatabaseService = () => {
  const clientMock = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    withClient: jest
      .fn()
      .mockImplementation(
        async (fn: (c: typeof clientMock) => Promise<unknown>) =>
          fn(clientMock),
      ),
    withTransaction: jest
      .fn()
      .mockImplementation(
        async (fn: (c: typeof clientMock) => Promise<unknown>) => {
          await clientMock.query('BEGIN');
          try {
            const result = await fn(clientMock);
            await clientMock.query('COMMIT');
            return result;
          } catch (error) {
            await clientMock.query('ROLLBACK');
            throw error;
          }
        },
      ),
    _clientMock: clientMock,
  } as unknown as DatabaseService & { _clientMock: typeof clientMock };
};

function stubGuardedSql(
  client: { query: jest.Mock },
  ownerCount: number,
  options: { allowRoleUpdate?: boolean } = {},
): void {
  client.query.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    if (sql.includes('FOR UPDATE OF member')) {
      return { rows: [ownerRow] };
    }
    if (sql.includes('FOR UPDATE;')) {
      return { rows: [{ id: 'member-1' }] };
    }
    if (sql.includes('count(*)')) {
      return { rows: [{ count: ownerCount }] };
    }
    if (
      options.allowRoleUpdate &&
      sql.includes('UPDATE orgs.workspace_members SET role')
    ) {
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

function queryIncludes(
  client: { query: jest.Mock },
  snippet: string,
): boolean {
  return client.query.mock.calls.some(
    (call: unknown[]) =>
      typeof call[0] === 'string' && call[0].includes(snippet),
  );
}

describe('GroupsRepository last-owner SQL guards', () => {
  it('changeMemberRoleGuarded blocks demoting the last admin', async () => {
    const db = makeDatabaseService();
    const client = db._clientMock;
    stubGuardedSql(client, 1);

    const repo = new GroupsRepository(db);
    const result = await repo.changeMemberRoleGuarded(
      'group-1',
      'member-1',
      'member',
    );

    expect(result.blockedLastOwner).toBe(true);
    expect(result.member?.role).toBe('admin');
    expect(
      queryIncludes(client, 'UPDATE orgs.workspace_members SET role'),
    ).toBe(false);
  });

  it('changeMemberRoleGuarded allows demote when owner count is 2', async () => {
    const db = makeDatabaseService();
    const client = db._clientMock;
    stubGuardedSql(client, 2, { allowRoleUpdate: true });

    const repo = new GroupsRepository(db);
    const result = await repo.changeMemberRoleGuarded(
      'group-1',
      'member-1',
      'member',
    );

    expect(result.blockedLastOwner).toBe(false);
    expect(result.member?.role).toBe('member');
    expect(
      queryIncludes(client, 'UPDATE orgs.workspace_members SET role'),
    ).toBe(true);
  });

  it('removeMemberGuardedWithClient blocks removing the last admin', async () => {
    const db = makeDatabaseService();
    const client = db._clientMock;
    stubGuardedSql(client, 1);

    const repo = new GroupsRepository(db);
    const result = await repo.removeMemberGuardedWithClient(
      client,
      'group-1',
      'member-1',
      'actor-1',
    );

    expect(result.blockedLastOwner).toBe(true);
    expect(result.member?.role).toBe('admin');
    expect(queryIncludes(client, "member_status = 'removed'")).toBe(false);
  });
});
