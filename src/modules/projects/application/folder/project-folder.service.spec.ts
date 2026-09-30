import { NotFoundException } from '@nestjs/common';

import type {
  ProjectFolderLink,
  ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import type {
  ProjectsRepository,
  ProvisionedProjectRow,
  WorkspaceProjectSummaryRow,
} from '../../infrastructure/projects.repository';
import type { CatalogService } from '../catalog/catalog.service';
import { ProjectFolderService } from './project-folder.service';

const GROUP = 'group-1';
const DELIVERY = 'delivery-1';

function summaryRow(
  id: string,
  type: string,
  name = id,
): WorkspaceProjectSummaryRow {
  return {
    id,
    repo_full_name: `Org/${name}`,
    service_name: name,
    repo_name: name,
    repo_shape: 'multi-repo',
    project_type_id: type,
    status: 'provisioned',
  };
}

function selfRow(id: string, type: string): ProvisionedProjectRow {
  return {
    ...summaryRow(id, type),
    workspace_id: GROUP,
  } as unknown as ProvisionedProjectRow;
}

function build(options: {
  self: ProvisionedProjectRow | null;
  folder: ProjectFolderLink | null;
  visible?: WorkspaceProjectSummaryRow[];
}) {
  const projectsRepository = {
    findByIdAndUser: jest.fn().mockResolvedValue(options.self),
    listVisibleSummariesByIds: jest
      .fn()
      .mockResolvedValue(options.visible ?? []),
  };
  const catalogService = {
    getProjectOptions: () => ({
      projectTypes: [
        { id: 'react', kind: 'frontend' },
        { id: 'nest', kind: 'backend' },
      ],
    }),
  };
  const projectLink = {
    getProjectFolder: jest.fn().mockResolvedValue(options.folder),
  };
  const service = new ProjectFolderService(
    projectsRepository as unknown as ProjectsRepository,
    catalogService as unknown as CatalogService,
    projectLink as unknown as ProjectLinkPort,
  );
  return { service, projectsRepository, projectLink };
}

const folderOf = (
  repositories: ProjectFolderLink['repositories'],
): ProjectFolderLink => ({
  deliveryProjectId: DELIVERY,
  groupId: GROUP,
  name: 'Testfinals',
  repositories,
});

describe('ProjectFolderService.getProjectFolder', () => {
  it('lists frontend before backend regardless of row order', async () => {
    const { service } = build({
      self: selfRow('be', 'nest'),
      folder: folderOf([
        {
          projectId: 'be',
          name: 'testfinals-be',
          repoFullName: 'Org/testfinals-be',
        },
        {
          projectId: 'fe',
          name: 'testfinals-fe',
          repoFullName: 'Org/testfinals-fe',
        },
      ]),
      visible: [summaryRow('fe', 'react', 'testfinals-fe')],
    });

    const result = await service.getProjectFolder('be', 'user-1');

    expect(result.deliveryProjectId).toBe(DELIVERY);
    expect(result.groupId).toBe(GROUP);
    expect(result.name).toBe('Testfinals');
    expect(result.repositories.map((r) => [r.projectId, r.role])).toEqual([
      ['fe', 'frontend'],
      ['be', 'backend'],
    ]);
    expect(result.repositories[0]).toMatchObject({
      name: 'testfinals-fe',
      repoFullName: 'Org/testfinals-fe',
      status: 'provisioned',
    });
  });

  it('orders services after backend, then by name', async () => {
    const svcB = {
      ...summaryRow('s2', 'nest', 'b-svc'),
      repo_shape: 'microservices',
    };
    const svcA = {
      ...summaryRow('s1', 'nest', 'a-svc'),
      repo_shape: 'microservices',
    };
    const { service } = build({
      self: selfRow('be', 'nest'),
      folder: folderOf([
        { projectId: 's2', name: 'b-svc', repoFullName: null },
        { projectId: 's1', name: 'a-svc', repoFullName: null },
        { projectId: 'be', name: 'be', repoFullName: null },
      ]),
      visible: [svcB, svcA],
    });

    const result = await service.getProjectFolder('be', 'user-1');

    expect(result.repositories.map((r) => r.projectId)).toEqual([
      'be',
      's1',
      's2',
    ]);
  });

  it('returns the project alone when it is not filed under a delivery project', async () => {
    const { service, projectsRepository } = build({
      self: selfRow('solo', 'react'),
      folder: null,
    });

    const result = await service.getProjectFolder('solo', 'user-1');

    expect(result).toEqual({
      deliveryProjectId: null,
      groupId: GROUP,
      name: 'solo',
      repositories: [
        {
          projectId: 'solo',
          name: 'solo',
          repoFullName: 'Org/solo',
          role: 'frontend',
          status: 'provisioned',
        },
      ],
    });
    expect(projectsRepository.listVisibleSummariesByIds).not.toHaveBeenCalled();
  });

  it('omits a sibling the caller cannot see but keeps the requested project', async () => {
    const { service, projectsRepository } = build({
      self: selfRow('be', 'nest'),
      folder: folderOf([
        { projectId: 'fe', name: 'testfinals-fe', repoFullName: null },
        { projectId: 'be', name: 'testfinals-be', repoFullName: null },
      ]),
      visible: [],
    });

    const result = await service.getProjectFolder('be', 'user-1');

    expect(result.repositories.map((r) => r.projectId)).toEqual(['be']);
    expect(projectsRepository.listVisibleSummariesByIds).toHaveBeenCalledWith(
      ['fe'],
      'user-1',
    );
  });

  it('keeps a repository row with no linked project as a null projectId', async () => {
    const { service } = build({
      self: selfRow('be', 'nest'),
      folder: folderOf([
        {
          projectId: null,
          name: 'orphan-repo',
          repoFullName: 'Org/orphan-repo',
        },
        { projectId: 'be', name: 'testfinals-be', repoFullName: null },
      ]),
    });

    const result = await service.getProjectFolder('be', 'user-1');

    expect(result.repositories).toEqual([
      expect.objectContaining({ projectId: 'be', role: 'backend' }),
      {
        projectId: null,
        name: 'orphan-repo',
        repoFullName: 'Org/orphan-repo',
        role: null,
        status: null,
      },
    ]);
  });

  it('always includes the requested project even if its own row is archived', async () => {
    const { service } = build({
      self: selfRow('be', 'nest'),
      folder: folderOf([
        { projectId: 'fe', name: 'testfinals-fe', repoFullName: null },
      ]),
      visible: [summaryRow('fe', 'react', 'testfinals-fe')],
    });

    const result = await service.getProjectFolder('be', 'user-1');

    expect(result.repositories.map((r) => r.projectId)).toEqual(['fe', 'be']);
  });

  it('throws 404 before reading the hierarchy when the caller cannot see the project', async () => {
    const { service, projectLink } = build({ self: null, folder: null });

    await expect(
      service.getProjectFolder('nope', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(projectLink.getProjectFolder).not.toHaveBeenCalled();
  });

  it('does not swallow a hierarchy failure', async () => {
    const { service, projectLink } = build({
      self: selfRow('be', 'nest'),
      folder: null,
    });
    projectLink.getProjectFolder.mockRejectedValue(new Error('db down'));

    await expect(service.getProjectFolder('be', 'user-1')).rejects.toThrow(
      'db down',
    );
  });
});
