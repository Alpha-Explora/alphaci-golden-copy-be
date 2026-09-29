import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectLifecyclePortAdapter } from './project-lifecycle-port.adapter';
import type { ProjectLifecycleService } from './project-lifecycle.service';

function setup(disconnect: jest.Mock, exists: boolean) {
  const lifecycle = {
    disconnectProject: disconnect,
  } as unknown as ProjectLifecycleService;
  const projects = {
    findByIdAndUser: jest.fn().mockResolvedValue({ repo_full_name: 'org/app' }),
    existsById: jest.fn().mockResolvedValue(exists),
  } as unknown as ProjectsRepository;
  return new ProjectLifecyclePortAdapter(lifecycle, projects);
}

describe('ProjectLifecyclePortAdapter.disconnectProject', () => {
  it('passes the server-read repo name when GitHub deletion is requested', async () => {
    const disconnect = jest.fn().mockResolvedValue({ githubRepoDeleted: true });
    const adapter = setup(disconnect, true);

    await expect(
      adapter.disconnectProject('p1', 'u1', { deleteGithubRepo: true }, 'tok'),
    ).resolves.toEqual({ githubRepoDeleted: true });
    expect(disconnect).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({
        deleteGithubRepo: true,
        confirmRepoName: 'org/app',
      }),
      'tok',
    );
  });

  it('keeps a 404 for a project that is really gone', async () => {
    const adapter = setup(
      jest.fn().mockRejectedValue(new NotFoundException()),
      false,
    );

    await expect(
      adapter.disconnectProject('p1', 'u1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turns a 404 for a project the user cannot see into a 403', async () => {
    const adapter = setup(
      jest.fn().mockRejectedValue(new NotFoundException()),
      true,
    );

    const error: unknown = await adapter
      .disconnectProject('p1', 'u1', {})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'PROJECT_DELETE_FORBIDDEN',
    });
  });
});
