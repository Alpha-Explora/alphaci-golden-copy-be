import { UnauthorizedException } from '@nestjs/common';

import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from '../application/workspaces.service';

describe('WorkspacesController', () => {
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
    }) as unknown as jest.Mocked<WorkspacesService>;

  it('returns persisted workspaces for the current user', async () => {
    const service = makeService();
    const controller = new WorkspacesController(service);

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
    const controller = new WorkspacesController(makeService());

    expect(() => controller.getMyWorkspaces({ session: {} } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it('lists members for the current workspace', async () => {
    const service = makeService();
    const controller = new WorkspacesController(service);

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
});
