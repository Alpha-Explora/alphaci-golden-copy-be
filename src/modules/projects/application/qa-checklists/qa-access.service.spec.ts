import { QaAccessService } from './qa-access.service';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';

const makeProjectsRepository = (overrides: Partial<ProjectsRepository> = {}) =>
  ({
    canCreateInWorkspace: jest.fn().mockResolvedValue(false),
    isGlobalProjectCreator: jest.fn().mockResolvedValue(false),
    findByIdAndUser: jest.fn().mockResolvedValue(null),
    ...overrides,
  }) as unknown as ProjectsRepository;

describe('QaAccessService', () => {
  it('canAccessWorkspace delegates to ProjectsRepository.canCreateInWorkspace', async () => {
    const projectsRepository = makeProjectsRepository({
      canCreateInWorkspace: jest.fn().mockResolvedValue(true),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(
      access.canAccessWorkspace('user-1', 'workspace-1'),
    ).resolves.toBe(true);
    expect(projectsRepository.canCreateInWorkspace).toHaveBeenCalledWith(
      'user-1',
      'workspace-1',
    );
  });

  it('canManage delegates to ProjectsRepository.isGlobalProjectCreator', async () => {
    const projectsRepository = makeProjectsRepository({
      isGlobalProjectCreator: jest.fn().mockResolvedValue(true),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(access.canManage('user-1')).resolves.toBe(true);
    expect(projectsRepository.isGlobalProjectCreator).toHaveBeenCalledWith(
      'user-1',
    );
  });

  it('findVisibleProjectWorkspace calls findByIdAndUser with no allowedRoles arg (default visibility)', async () => {
    const projectsRepository = makeProjectsRepository({
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        workspace_id: 'workspace-1',
      }),
    });
    const access = new QaAccessService(projectsRepository);

    const result = await access.findVisibleProjectWorkspace(
      'project-1',
      'user-1',
    );

    expect(projectsRepository.findByIdAndUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
    expect(result).toEqual({ workspaceId: 'workspace-1' });
  });

  it('findVisibleProjectWorkspace returns null when the project is not visible (404 territory)', async () => {
    const projectsRepository = makeProjectsRepository({
      findByIdAndUser: jest.fn().mockResolvedValue(null),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(
      access.findVisibleProjectWorkspace('project-1', 'user-1'),
    ).resolves.toBeNull();
  });

  it('findVisibleProjectWorkspace surfaces a null workspace_id (an individual/detached project)', async () => {
    const projectsRepository = makeProjectsRepository({
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        workspace_id: null,
      }),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(
      access.findVisibleProjectWorkspace('project-1', 'user-1'),
    ).resolves.toEqual({ workspaceId: null });
  });
});
