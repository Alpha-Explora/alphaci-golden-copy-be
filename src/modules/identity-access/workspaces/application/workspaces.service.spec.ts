import type { WorkspacesRepository } from '../infrastructure/workspaces.repository';
import type { WorkspaceAccessService } from './workspace-access.service';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService', () => {
  const makeRepository = () =>
    ({
      listForUser: jest.fn().mockResolvedValue([]),
      listMembers: jest.fn().mockResolvedValue([]),
    }) as unknown as jest.Mocked<WorkspacesRepository>;
  const makeAccessService = () =>
    ({
      assertWorkspaceRole: jest.fn().mockResolvedValue({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        role: 'admin',
      }),
    }) as unknown as jest.Mocked<WorkspaceAccessService>;

  it('returns the teams the caller belongs to', async () => {
    const repository = makeRepository();
    repository.listForUser.mockResolvedValueOnce([
      {
        id: 'workspace-2',
        name: 'Team workspace',
        kind: 'team',
        role: 'member',
      },
    ]);
    const service = new WorkspacesService(repository, makeAccessService());

    await expect(service.getMyWorkspaces('user-1')).resolves.toEqual({
      enabled: true,
      items: [
        {
          id: 'workspace-2',
          name: 'Team workspace',
          kind: 'team',
          role: 'member',
        },
      ],
    });
  });

  it('returns nothing for a caller who belongs to no team', async () => {
    const repository = makeRepository();
    const service = new WorkspacesService(repository, makeAccessService());

    await expect(service.getMyWorkspaces('user-1')).resolves.toEqual({
      enabled: true,
      items: [],
    });
  });

  it('lists members after read access is verified', async () => {
    const repository = makeRepository();
    const accessService = makeAccessService();
    repository.listMembers.mockResolvedValueOnce([
      {
        id: 'member-1',
        workspaceId: 'workspace-1',
        userId: 'user-1',
        role: 'admin',
        login: 'tone',
        name: 'Tone',
        email: null,
        avatarUrl: null,
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    ]);
    const service = new WorkspacesService(repository, accessService);

    await expect(
      service.listMembers('workspace-1', 'user-1'),
    ).resolves.toHaveLength(1);
    expect(accessService.assertWorkspaceRole).toHaveBeenCalledWith(
      'workspace-1',
      'user-1',
      ['admin', 'delegated_lead', 'member', 'viewer'],
    );
  });
});
