import type { DatabaseService } from '#kernel/db/database.service';
import { WorkspacesRepository } from './workspaces.repository';

const makeDatabaseService = (query: jest.Mock) =>
  ({ query }) as unknown as DatabaseService;

describe('WorkspacesRepository', () => {
  let query: jest.Mock;
  let repository: WorkspacesRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new WorkspacesRepository(makeDatabaseService(query));
  });

  it('lists workspaces for a user membership', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'workspace-1',
          name: 'Team workspace',
          kind: 'team',
          role: 'admin',
        },
      ],
    });

    await expect(repository.listForUser('user-1')).resolves.toEqual([
      {
        id: 'workspace-1',
        name: 'Team workspace',
        kind: 'team',
        role: 'admin',
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM orgs.workspace_members'),
      ['user-1'],
    );
  });

  it('lists only active memberships with the role derived from app_role', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repository.listForUser('user-1');

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("member.member_status = 'active'");
    expect(sql).toContain("app_user.app_role IN ('admin', 'lead')");
    expect(sql).toContain('JOIN identity.app_users AS app_user');
  });

  it('findMembership ignores removed members', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(repository.findMembership('w-1', 'u-1')).resolves.toBeNull();

    expect(query.mock.calls[0][0]).toContain("member_status = 'active'");
  });

  /* Personal workspaces were removed: a workspace IS a team, and the only way
   * into one is being added as a member. Nothing in the repository may create
   * a workspace on a caller's behalf. */
  it('exposes no way to create a workspace implicitly', () => {
    expect(
      (repository as unknown as Record<string, unknown>)
        .createPersonalWorkspace,
    ).toBeUndefined();
  });

  it('lists workspace members with user profile fields', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'member-1',
          workspace_id: 'workspace-1',
          user_id: 'user-1',
          role: 'admin',
          created_at: new Date('2026-06-15T00:00:00.000Z'),
          login: 'tone',
          display_name: 'Tone',
          email: 'tone@example.test',
          avatar_url: null,
        },
      ],
    });

    await expect(repository.listMembers('workspace-1')).resolves.toEqual([
      {
        id: 'member-1',
        workspaceId: 'workspace-1',
        userId: 'user-1',
        role: 'admin',
        login: 'tone',
        name: 'Tone',
        email: 'tone@example.test',
        avatarUrl: null,
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN identity.app_users'),
      ['workspace-1'],
    );
  });

  it('finds direct workspace membership', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: 'workspace-1',
          user_id: 'user-1',
          role: 'member',
        },
      ],
    });

    await expect(
      repository.findMembership('workspace-1', 'user-1'),
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'member',
    });
  });

  it('finds workspace membership through a project', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: 'workspace-1',
          user_id: 'user-1',
          role: 'viewer',
        },
      ],
    });

    await expect(
      repository.findProjectMembership('project-1', 'user-1'),
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'viewer',
    });
    expect(query.mock.calls[0][0]).toContain('projects.provisioned_projects');
    expect(query.mock.calls[0][0]).toContain('orgs.workspace_members');
  });
});
