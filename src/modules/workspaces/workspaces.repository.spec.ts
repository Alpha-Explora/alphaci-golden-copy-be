import type { DatabaseService } from '../../kernel/db/database.service';
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
          name: 'Personal workspace',
          kind: 'personal',
          role: 'admin',
        },
      ],
    });

    await expect(repository.listForUser('user-1')).resolves.toEqual([
      {
        id: 'workspace-1',
        name: 'Personal workspace',
        kind: 'personal',
        role: 'admin',
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM orgs.workspace_members'),
      ['user-1'],
    );
  });

  it('creates a personal workspace and owner membership', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'workspace-1',
            name: 'Personal workspace',
            kind: 'personal',
            role: 'admin',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repository.createPersonalWorkspace('user-1')).resolves.toEqual(
      {
        id: 'workspace-1',
        name: 'Personal workspace',
        kind: 'personal',
        role: 'admin',
      },
    );
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO orgs.workspaces'),
      ['user-1'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO orgs.workspace_members'),
      ['workspace-1', 'user-1'],
    );
  });

  it('throws when workspace insert does not return a row', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(repository.createPersonalWorkspace('user-1')).rejects.toThrow(
      'Workspace insert did not return a row',
    );
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

  it('adds a registered user by login', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'member-2',
            workspace_id: 'workspace-1',
            user_id: 'user-2',
            role: 'member',
            created_at: new Date('2026-06-15T00:00:00.000Z'),
            login: 'dev',
            display_name: 'Dev User',
            email: null,
            avatar_url: null,
          },
        ],
      });

    await expect(
      repository.addMemberByLoginOrEmail('workspace-1', 'dev', 'member'),
    ).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      userId: 'user-2',
      role: 'member',
      login: 'dev',
    });
    expect(query.mock.calls[0][0]).toContain('lower(login)');
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT');
  });

  it('returns null when member lookup by login has no match', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.addMemberByLoginOrEmail('workspace-1', 'missing', 'viewer'),
    ).resolves.toBeNull();
  });

  it('updates a member role and returns the member summary', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-2' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'member-2',
            workspace_id: 'workspace-1',
            user_id: 'user-2',
            role: 'delegated_lead',
            created_at: '2026-06-15T00:00:00.000Z',
            login: 'dev',
            display_name: null,
            email: null,
            avatar_url: null,
          },
        ],
      });

    await expect(
      repository.updateMemberRole('workspace-1', 'member-2', 'delegated_lead'),
    ).resolves.toMatchObject({
      id: 'member-2',
      role: 'delegated_lead',
      name: 'dev',
    });
  });

  it('removes a member by membership id', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'member-2' }] });

    await expect(
      repository.removeMember('workspace-1', 'member-2'),
    ).resolves.toEqual({ id: 'member-2' });
  });
});
