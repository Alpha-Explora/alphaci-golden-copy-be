import { BadRequestException, UnauthorizedException } from '@nestjs/common';

import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesController', () => {
  const makeConfigService = (enabled = true) =>
    ({
      getOrThrow: jest.fn().mockReturnValue({
        workspaces: { enabled },
      }),
    }) as never;
  const makeService = () =>
    ({
      getMyWorkspaces: jest.fn().mockResolvedValue({
        enabled: true,
        items: [
          {
            id: 'workspace-1',
            name: "tone's workspace",
            kind: 'personal',
            role: 'admin',
          },
        ],
      }),
      listMembers: jest.fn().mockResolvedValue([
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
      ]),
      addMember: jest.fn().mockResolvedValue({
        id: 'member-2',
        workspaceId: 'workspace-1',
        userId: 'user-2',
        role: 'member',
        login: 'dev',
        name: 'Dev User',
        email: null,
        avatarUrl: null,
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
      updateMemberRole: jest.fn().mockResolvedValue({
        id: 'member-2',
        role: 'delegated_lead',
      }),
      removeMember: jest.fn().mockResolvedValue({
        id: 'member-2',
        removed: true,
      }),
    }) as unknown as jest.Mocked<WorkspacesService>;

  it('returns persisted workspaces for the current user', async () => {
    const service = makeService();
    const controller = new WorkspacesController(makeConfigService(), service);

    await expect(
      controller.getMyWorkspaces({
        session: { user: { id: 'user-1', login: 'tone' } },
      } as never),
    ).resolves.toEqual({
      enabled: true,
      items: [
        {
          id: 'workspace-1',
          name: "tone's workspace",
          kind: 'personal',
          role: 'admin',
        },
      ],
    });
    expect(service.getMyWorkspaces).toHaveBeenCalledWith('user-1');
  });

  it('rejects unauthenticated workspace requests', () => {
    const controller = new WorkspacesController(
      makeConfigService(),
      makeService(),
    );

    expect(() => controller.getMyWorkspaces({ session: {} } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it('returns disabled workspace contract when workspaces are disabled', () => {
    const service = makeService();
    const controller = new WorkspacesController(
      makeConfigService(false),
      service,
    );

    expect(
      controller.getMyWorkspaces({
        session: { userId: 'user-1' },
      } as never),
    ).toEqual({ enabled: false, items: [] });
    expect(service.getMyWorkspaces).not.toHaveBeenCalled();
  });

  it('lists members for the current workspace', async () => {
    const service = makeService();
    const controller = new WorkspacesController(makeConfigService(), service);

    await expect(
      controller.listMembers(
        { session: { user: { id: 'user-1', login: 'tone' } } } as never,
        'workspace-1',
      ),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'member-1', role: 'admin' }),
    ]);
    expect(service.listMembers).toHaveBeenCalledWith('workspace-1', 'user-1');
  });

  it('adds a workspace member by login or email', async () => {
    const service = makeService();
    const controller = new WorkspacesController(makeConfigService(), service);

    await expect(
      controller.addMember(
        { session: { userId: 'user-1' } } as never,
        'workspace-1',
        {
          loginOrEmail: 'dev',
          role: 'member',
        },
      ),
    ).resolves.toMatchObject({ id: 'member-2', role: 'member' });
    expect(service.addMember).toHaveBeenCalledWith('workspace-1', 'user-1', {
      loginOrEmail: 'dev',
      role: 'member',
    });
  });

  it('updates a workspace member role', async () => {
    const service = makeService();
    const controller = new WorkspacesController(makeConfigService(), service);

    await expect(
      controller.updateMemberRole(
        { session: { userId: 'user-1' } } as never,
        'workspace-1',
        'member-2',
        { role: 'delegated_lead' },
      ),
    ).resolves.toMatchObject({ id: 'member-2', role: 'delegated_lead' });
    expect(service.updateMemberRole).toHaveBeenCalledWith(
      'workspace-1',
      'user-1',
      'member-2',
      'delegated_lead',
    );
  });

  it('passes last-owner demotion errors through the controller', async () => {
    const service = makeService();
    service.updateMemberRole.mockRejectedValueOnce(
      new BadRequestException('Workspace must keep at least one owner'),
    );
    const controller = new WorkspacesController(makeConfigService(), service);

    await expect(
      controller.updateMemberRole(
        { session: { userId: 'user-1' } } as never,
        'workspace-1',
        'member-owner',
        { role: 'delegated_lead' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes a workspace member', async () => {
    const service = makeService();
    const controller = new WorkspacesController(makeConfigService(), service);

    await expect(
      controller.removeMember(
        { session: { userId: 'user-1' } } as never,
        'workspace-1',
        'member-2',
      ),
    ).resolves.toEqual({ id: 'member-2', removed: true });
    expect(service.removeMember).toHaveBeenCalledWith(
      'workspace-1',
      'user-1',
      'member-2',
    );
  });
});
