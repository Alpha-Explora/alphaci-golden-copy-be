import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { WorkspacesPort } from '#kernel/ports/workspaces.port';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import { WorkspaceGateService } from './workspace-gate.service';

function build(appRole: string, inWorkspace = true) {
  const projectsRepository = {
    findAppRole: jest.fn().mockResolvedValue(appRole),
    canCreateInWorkspace: jest.fn().mockResolvedValue(inWorkspace),
  };
  const service = new WorkspaceGateService(
    projectsRepository as unknown as ProjectsRepository,
    undefined as unknown as WorkspacesPort,
  );
  return { service, projectsRepository };
}

describe('WorkspaceGateService repository-create gate', () => {
  it.each(['lead', 'qa'])(
    '%s is refused with 403 REPOSITORY_CREATE_FORBIDDEN, with or without a Project',
    async (role) => {
      const { service } = build(role);
      for (const dp of [undefined, 'dp-1']) {
        const error = await service
          .resolveWorkspaceIdForCreate('user-1', 'ws-1', dp)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'REPOSITORY_CREATE_FORBIDDEN',
          message: 'Developers create repositories inside a Project.',
        });
      }
    },
  );

  it('a member without a Project gets 400 PROJECT_REQUIRED', async () => {
    const { service, projectsRepository } = build('member');
    const error = await service
      .resolveWorkspaceIdForCreate('user-1', 'ws-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'PROJECT_REQUIRED',
      message: 'Choose the Project this repository belongs to.',
    });
    expect(projectsRepository.canCreateInWorkspace).not.toHaveBeenCalled();
  });

  it('a member into a Project of a team they belong to passes', async () => {
    const { service } = build('member', true);
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).resolves.toBe('ws-1');
  });

  it('a member naming a team they are not in is refused (403)', async () => {
    const { service } = build('member', false);
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-other', 'dp-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an admin is unchanged: the Project stays optional', async () => {
    const { service } = build('admin');
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1'),
    ).resolves.toBe('ws-1');
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).resolves.toBe('ws-1');
  });
});
