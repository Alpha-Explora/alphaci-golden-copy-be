import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import type { CatalogService } from '../catalog/catalog.service';
import {
  ProjectProvisioningService,
  projectRole,
} from './project-provisioning.service';

describe('projectRole', () => {
  it.each([
    ['multi-repo', 'frontend', 'frontend'],
    ['multi', 'backend', 'backend'],
    ['multi-repo', undefined, 'app'],
    ['microservices', 'backend', 'service'],
    ['standalone', 'frontend', 'app'],
    ['monorepo', 'frontend', 'app'],
    [null, undefined, 'app'],
  ] as const)('shape %s with stack kind %s is %s', (shape, kind, expected) => {
    expect(projectRole(shape, kind)).toBe(expected);
  });
});

describe('ProjectProvisioningService.listWorkspaceProjects', () => {
  it('names each project and derives its role from the declared stack kind', async () => {
    const projectsRepository = {
      listWorkspaceProjectSummaries: jest.fn().mockResolvedValue([
        {
          id: 'project-fe',
          repo_full_name: 'Org/testfinals-fe',
          service_name: 'testfinals-frontend',
          repo_name: 'testfinals-fe',
          repo_shape: 'multi-repo',
          project_type_id: 'react',
          status: 'provisioned',
        },
        {
          id: 'project-be',
          repo_full_name: 'Org/testfinals-be',
          service_name: '  ',
          repo_name: 'testfinals-be',
          repo_shape: 'multi-repo',
          project_type_id: 'dotnet',
          status: 'provisioned',
        },
        {
          id: 'project-hierarchy',
          repo_full_name: 'Org/managed',
          service_name: null,
          repo_name: null,
          repo_shape: null,
          project_type_id: null,
          status: 'provisioned',
        },
      ]),
    };
    const catalogService = {
      getProjectOptions: () => ({
        projectTypes: [
          { id: 'react', kind: 'frontend' },
          { id: 'dotnet', kind: 'backend' },
        ],
      }),
    };
    const service = new ProjectProvisioningService(
      projectsRepository as unknown as ProjectsRepository,
      catalogService as unknown as CatalogService,
    );

    const projects = await service.listWorkspaceProjects('workspace-1');

    expect(
      projectsRepository.listWorkspaceProjectSummaries,
    ).toHaveBeenCalledWith('workspace-1');
    expect(projects).toEqual([
      {
        id: 'project-fe',
        name: 'testfinals-frontend',
        repoFullName: 'Org/testfinals-fe',
        role: 'frontend',
        status: 'provisioned',
        repoShape: 'multi-repo',
      },
      expect.objectContaining({
        id: 'project-be',
        name: 'testfinals-be',
        role: 'backend',
      }),
      expect.objectContaining({
        id: 'project-hierarchy',
        name: 'managed',
        role: 'app',
      }),
    ]);
  });
});
