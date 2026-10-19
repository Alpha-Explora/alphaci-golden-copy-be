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

function queryIncludes(client: { query: jest.Mock }, snippet: string): boolean {
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

describe('GroupsRepository addMemberDirect', () => {
  it('addMemberDirect upserts an active member and clears removal columns', async () => {
    const db = makeDatabaseService();
    const repo = new GroupsRepository(db);

    await repo.addMemberDirect('group-1', 'user-2', 'member', 'actor-1');

    expect(db.query).not.toHaveBeenCalled();
    const [sql, params] = db._clientMock.query.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('INSERT INTO orgs.workspace_members');
    expect(sql).toContain('ON CONFLICT (workspace_id, user_id)');
    expect(sql).toContain("member_status = 'active'");
    expect(sql).toContain('removed_at = NULL');
    expect(sql).toContain("WHERE workspace_members.member_status <> 'active'");
    expect(params).toEqual(['group-1', 'user-2', 'member', 'actor-1']);
  });

  it('rolls membership back when notification enqueueing fails', async () => {
    const db = makeDatabaseService();
    db._clientMock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('RETURNING id')
        ? [{ id: 'new-member' }]
        : sql.includes('SELECT w.name')
          ? [{ name: 'Team A', login: 'lead' }]
          : [],
    }));
    const notify = jest.fn().mockRejectedValue(new Error('outbox offline'));
    await expect(
      new GroupsRepository(db).addMemberDirect(
        'g',
        'u',
        'member',
        'lead',
        notify,
      ),
    ).rejects.toThrow('outbox offline');
    expect(notify).toHaveBeenCalledWith(db._clientMock, {
      groupName: 'Team A',
      actorLogin: 'lead',
    });
    expect(db._clientMock.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(db._clientMock.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('does not notify when a concurrent request already activated membership', async () => {
    const db = makeDatabaseService();
    const notify = jest.fn();
    await expect(
      new GroupsRepository(db).addMemberDirect(
        'g',
        'u',
        'member',
        'lead',
        notify,
      ),
    ).resolves.toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('GroupsRepository listMembers', () => {
  it('returns each member with their global app role for the persona badge', async () => {
    const db = makeDatabaseService();
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        { ...ownerRow, app_role: 'lead' },
        {
          ...ownerRow,
          id: 'member-2',
          user_id: 'user-2',
          role: 'member',
          app_role: 'qa',
          login: 'qa-one',
        },
      ],
    });
    const repo = new GroupsRepository(db);

    const members = await repo.listMembers('group-1');

    const [sql] = (db.query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('user_profile.app_role,');
    expect(members.map((member) => member.appRole)).toEqual(['lead', 'qa']);
  });
});
