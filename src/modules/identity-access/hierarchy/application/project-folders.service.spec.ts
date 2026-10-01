import { NotFoundException } from '@nestjs/common';

import type {
  ProjectLookupPort,
  WorkspaceProjectSummary,
} from '#kernel/ports/project-lookup.port';
import type {
  ProjectFolderRow,
  ProjectFoldersRepository,
} from '../infrastructure/project-folders.repository';
import type { HierarchyAccessService } from './hierarchy-access.service';
import { groupFolders, ProjectFoldersService } from './project-folders.service';

const row = (overrides: Partial<ProjectFolderRow>): ProjectFolderRow => ({
  delivery_project_id: 'dp-testfinals',
  system_id: 'system-testfinals',
  name: 'testfinals',
  created_at: '2026-09-01T00:00:00Z',
  repository_id: null,
  repository_name: null,
  repo_full_name: null,
  repository_status: null,
  provisioned_project_id: null,
  ...overrides,
});

const summary = (
  overrides: Partial<WorkspaceProjectSummary>,
): WorkspaceProjectSummary => ({
  id: 'project-fe',
  name: 'testfinals-frontend',
  repoFullName: 'Org/testfinals-fe',
  role: 'frontend',
  status: 'provisioned',
  repoShape: 'multi-repo',
  ...overrides,
});

const pairRows: ProjectFolderRow[] = [
  row({
    repository_id: 'repo-fe',
    repository_name: 'testfinals-frontend',
    repo_full_name: 'Org/testfinals-fe',
    repository_status: 'active',
    provisioned_project_id: 'project-fe',
  }),
  row({
    repository_id: 'repo-be',
    repository_name: 'testfinals-backend',
    repo_full_name: 'Org/testfinals-be',
    repository_status: 'active',
    provisioned_project_id: 'project-be',
  }),
];

function setup({
  platformAdmin = false,
  role = 'member',
  appRole = 'member',
  rows = pairRows,
  linked = ['project-fe', 'project-be'],
  projects = [
    summary({}),
    summary({
      id: 'project-be',
      name: 'testfinals-backend',
      repoFullName: 'Org/testfinals-be',
      role: 'backend',
    }),
  ],
}: {
  platformAdmin?: boolean;
  role?: string;
  appRole?: string;
  rows?: ProjectFolderRow[];
  linked?: string[];
  projects?: WorkspaceProjectSummary[];
} = {}) {
  const repository = {
    listFolderRows: jest.fn().mockResolvedValue(rows),
    listLinkedProjectIds: jest.fn().mockResolvedValue(new Set(linked)),
  };
  const access = {
    isPlatformAdmin: jest.fn().mockResolvedValue(platformAdmin),
    getAppRole: jest.fn().mockResolvedValue(appRole),
    assertGroupMembership: jest.fn().mockResolvedValue({ role }),
  };
  const lookup = {
    listWorkspaceProjects: jest.fn().mockResolvedValue(projects),
  };
  const service = new ProjectFoldersService(
    repository as unknown as ProjectFoldersRepository,
    access as unknown as HierarchyAccessService,
    lookup as unknown as ProjectLookupPort,
  );
  return { service, repository, access, lookup };
}

describe('ProjectFoldersService.listProjectFolders', () => {
  it.each([
    ['admin', false, true, true],
    ['lead', false, true, false],
    ['member', false, false, true],
    ['qa', false, false, false],
    ['member', true, true, true],
  ])(
    'persona %s (platform admin %s) gets canCreateProject=%s, canCreateRepository=%s',
    async (appRole, platformAdmin, canCreateProject, canCreateRepository) => {
      const { service } = setup({ appRole, platformAdmin });
      const result = await service.listProjectFolders('group-1', 'user-1');
      expect(result.canCreateProject).toBe(canCreateProject);
      expect(result.canCreateRepository).toBe(canCreateRepository);
    },
  );

  it('returns one folder per project with its repositories and their roles', async () => {
    const { service, lookup } = setup();

    const result = await service.listProjectFolders('group-1', 'dev-1');

    expect(lookup.listWorkspaceProjects).toHaveBeenCalledWith('group-1');
    expect(result.canManage).toBe(false);
    expect(result.canCreateProject).toBe(false);
    expect(result.canCreateRepository).toBe(true);
    expect(result.unfiled).toEqual([]);
    expect(result.folders).toEqual([
      {
        deliveryProjectId: 'dp-testfinals',
        systemId: 'system-testfinals',
        name: 'testfinals',
        createdAt: '2026-09-01T00:00:00Z',
        repositories: [
          {
            repositoryId: 'repo-fe',
            name: 'testfinals-frontend',
            repoFullName: 'Org/testfinals-fe',
            status: 'active',
            project: {
              id: 'project-fe',
              role: 'frontend',
              status: 'provisioned',
              repoShape: 'multi-repo',
            },
          },
          expect.objectContaining({
            repositoryId: 'repo-be',
            project: expect.objectContaining({ role: 'backend' }),
          }),
        ],
      },
    ]);
  });

  it.each([
    ['admin', true],
    ['delegated_lead', true],
    ['member', false],
    ['viewer', false],
  ])('a %s gets canManage=%s', async (role, expected) => {
    const { service } = setup({ role });

    const result = await service.listProjectFolders('group-1', 'user-1');

    expect(result.canManage).toBe(expected);
  });

  it('lets a platform admin read without membership and manage', async () => {
    const { service, access } = setup({ platformAdmin: true });

    const result = await service.listProjectFolders('group-1', 'admin-1');

    expect(result.canManage).toBe(true);
    expect(access.assertGroupMembership).not.toHaveBeenCalled();
  });

  it('rejects a non-member before reading anything', async () => {
    const { service, access, repository, lookup } = setup();
    access.assertGroupMembership.mockRejectedValue(
      new NotFoundException('Group not found'),
    );

    await expect(
      service.listProjectFolders('group-1', 'stranger'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.listFolderRows).not.toHaveBeenCalled();
    expect(lookup.listWorkspaceProjects).not.toHaveBeenCalled();
  });

  it('lists team projects with no repository row as unfiled', async () => {
    const { service } = setup({
      linked: ['project-fe', 'project-be'],
      projects: [
        summary({}),
        summary({ id: 'project-be', role: 'backend' }),
        summary({
          id: 'project-blaine',
          name: 'blaine',
          repoFullName: 'Org/blaine',
          role: 'app',
          repoShape: 'standalone',
        }),
      ],
    });

    const result = await service.listProjectFolders('group-1', 'dev-1');

    expect(result.unfiled).toEqual([
      {
        id: 'project-blaine',
        name: 'blaine',
        repoFullName: 'Org/blaine',
        role: 'app',
        status: 'provisioned',
        repoShape: 'standalone',
      },
    ]);
  });

  it('does not resurface a project whose repository row is archived', async () => {
    const { service } = setup({
      rows: [row({})],
      linked: ['project-fe'],
      projects: [summary({})],
    });

    const result = await service.listProjectFolders('group-1', 'dev-1');

    expect(result.unfiled).toEqual([]);
  });
});

describe('groupFolders', () => {
  it('keeps an empty project as a folder with no repositories', () => {
    expect(groupFolders([row({})], new Map())).toEqual([
      expect.objectContaining({
        deliveryProjectId: 'dp-testfinals',
        repositories: [],
      }),
    ]);
  });

  it('reports a repository whose project is unknown with project null', () => {
    const folders = groupFolders(
      [
        row({
          repository_id: 'repo-x',
          repository_name: 'legacy',
          repository_status: 'pending',
          provisioned_project_id: 'project-gone',
        }),
      ],
      new Map(),
    );

    expect(folders[0]?.repositories).toEqual([
      {
        repositoryId: 'repo-x',
        name: 'legacy',
        repoFullName: null,
        status: 'pending',
        project: null,
      },
    ]);
  });

  it('keeps folders in the order the rows arrive', () => {
    const folders = groupFolders(
      [
        row({ delivery_project_id: 'dp-a', name: 'alpha' }),
        row({ delivery_project_id: 'dp-b', name: 'beta' }),
      ],
      new Map(),
    );

    expect(folders.map((folder) => folder.name)).toEqual(['alpha', 'beta']);
  });
});
