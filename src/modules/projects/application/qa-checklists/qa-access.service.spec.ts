import { QaAccessService } from './qa-access.service';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';

const makeProjectsRepository = (overrides: Partial<ProjectsRepository> = {}) =>
  ({
    canCreateInWorkspace: jest.fn().mockResolvedValue(false),
    findByIdAndUser: jest.fn().mockResolvedValue(null),
    findAppRole: jest.fn().mockResolvedValue('member'),
    listWorkspaceLeadIds: jest.fn().mockResolvedValue([]),
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

  it.each([
    ['admin', true],
    ['lead', true],
    ['member', false],
    ['qa', false],
  ])('canManage (checklists) for %s is %s', async (role, expected) => {
    const projectsRepository = makeProjectsRepository({
      findAppRole: jest.fn().mockResolvedValue(role),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(access.canManage('user-1')).resolves.toBe(expected);
    expect(projectsRepository.findAppRole).toHaveBeenCalledWith('user-1');
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

  it('findVisibleProject delegates to findByIdAndUser with no allowedRoles arg and returns the full row', async () => {
    const row = {
      id: 'project-1',
      workspace_id: 'workspace-1',
      user_id: 'owner-1',
      repo_full_name: 'org/repo',
    };
    const projectsRepository = makeProjectsRepository({
      findByIdAndUser: jest.fn().mockResolvedValue(row),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(
      access.findVisibleProject('project-1', 'user-1'),
    ).resolves.toEqual(row);
    expect(projectsRepository.findByIdAndUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
  });

  it('findVisibleProject returns null when the project is not visible', async () => {
    const projectsRepository = makeProjectsRepository({
      findByIdAndUser: jest.fn().mockResolvedValue(null),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(
      access.findVisibleProject('project-1', 'user-1'),
    ).resolves.toBeNull();
  });

  it('findAppRole delegates to ProjectsRepository.findAppRole', async () => {
    const projectsRepository = makeProjectsRepository({
      findAppRole: jest.fn().mockResolvedValue('lead'),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(access.findAppRole('user-1')).resolves.toBe('lead');
    expect(projectsRepository.findAppRole).toHaveBeenCalledWith('user-1');
  });

  it('listWorkspaceLeadIds delegates to ProjectsRepository.listWorkspaceLeadIds', async () => {
    const projectsRepository = makeProjectsRepository({
      listWorkspaceLeadIds: jest.fn().mockResolvedValue(['lead-1', 'lead-2']),
    });
    const access = new QaAccessService(projectsRepository);

    await expect(access.listWorkspaceLeadIds('workspace-1')).resolves.toEqual([
      'lead-1',
      'lead-2',
    ]);
    expect(projectsRepository.listWorkspaceLeadIds).toHaveBeenCalledWith(
      'workspace-1',
    );
  });
});
