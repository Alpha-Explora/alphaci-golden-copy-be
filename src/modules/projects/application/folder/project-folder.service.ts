import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { WorkspaceProjectRole } from '#kernel/ports/project-lookup.port';
import {
  PROJECT_LINK_PORT,
  type ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { CatalogService } from '../catalog/catalog.service';
import { toWorkspaceProjectSummary } from '../lifecycle/project-provisioning.service';

export interface ProjectFolderRepositoryView {
  /** Null when the repository row is not linked to an AlphaCI project. */
  projectId: string | null;
  name: string;
  repoFullName: string | null;
  role: WorkspaceProjectRole | null;
  status: string | null;
}

export interface ProjectFolderView {
  /** Null for a project that is not filed under any delivery project. */
  deliveryProjectId: string | null;
  groupId: string | null;
  name: string;
  repositories: ProjectFolderRepositoryView[];
}

const ROLE_ORDER: Record<WorkspaceProjectRole, number> = {
  frontend: 0,
  backend: 1,
  service: 2,
  app: 3,
};

/**
 * The project page's repository switcher: the sibling repositories of the
 * delivery project ("Project" folder) a project is filed under.
 *
 * Lives in Projects because the role of each repository is derived from its
 * declared stack here, and so that the visibility predicate on
 * provisioned_projects stays private to this context. The hierarchy rows are
 * reached through PROJECT_LINK_PORT, which Projects already consumes.
 */
@Injectable()
export class ProjectFolderService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly catalogService: CatalogService,
    @Inject(PROJECT_LINK_PORT)
    private readonly projectLink: ProjectLinkPort,
  ) {}

  async getProjectFolder(
    projectId: string,
    userId: string,
  ): Promise<ProjectFolderView> {
    // Visibility first: a caller who cannot see the project learns nothing.
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    const kindByType = new Map(
      this.catalogService
        .getProjectOptions()
        .projectTypes.map((type) => [type.id, type.kind]),
    );
    const self = toWorkspaceProjectSummary(
      {
        id: row.id,
        repo_full_name: row.repo_full_name,
        service_name: row.service_name,
        repo_name: null,
        repo_shape: row.repo_shape,
        project_type_id: row.project_type_id,
        status: row.status,
      },
      kindByType,
    );

    const folder = await this.projectLink.getProjectFolder(projectId);
    if (!folder) {
      return {
        deliveryProjectId: null,
        groupId: row.workspace_id ?? null,
        name: self.name,
        repositories: [
          {
            projectId: self.id,
            name: self.name,
            repoFullName: self.repoFullName,
            role: self.role,
            status: self.status,
          },
        ],
      };
    }

    const siblingIds = folder.repositories
      .map((repository) => repository.projectId)
      .filter((id): id is string => !!id && id !== projectId);
    const visible = new Map(
      (
        await this.projectsRepository.listVisibleSummariesByIds(
          siblingIds,
          userId,
        )
      ).map((sibling) => [
        sibling.id,
        toWorkspaceProjectSummary(sibling, kindByType),
      ]),
    );
    visible.set(self.id, self);

    const repositories: ProjectFolderRepositoryView[] = [];
    for (const repository of folder.repositories) {
      if (!repository.projectId) {
        repositories.push({
          projectId: null,
          name: repository.name,
          repoFullName: repository.repoFullName,
          role: null,
          status: null,
        });
        continue;
      }
      const project = visible.get(repository.projectId);
      // Not visible to the caller: omit rather than reveal it exists.
      if (!project) continue;
      repositories.push({
        projectId: project.id,
        name: repository.name || project.name,
        repoFullName: repository.repoFullName ?? project.repoFullName,
        role: project.role,
        status: project.status,
      });
    }

    // The requested project is always present, even if its own hierarchy row
    // was archived and so dropped from the folder's active repositories.
    if (!repositories.some((repository) => repository.projectId === self.id)) {
      repositories.push({
        projectId: self.id,
        name: self.name,
        repoFullName: self.repoFullName,
        role: self.role,
        status: self.status,
      });
    }

    repositories.sort(compareRepositories);

    return {
      deliveryProjectId: folder.deliveryProjectId,
      groupId: folder.groupId,
      name: folder.name,
      repositories,
    };
  }
}

function compareRepositories(
  a: ProjectFolderRepositoryView,
  b: ProjectFolderRepositoryView,
): number {
  // Unlinked rows (no role) sort after every classified repository.
  const rank = (repository: ProjectFolderRepositoryView) =>
    repository.role ? ROLE_ORDER[repository.role] : 4;
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}
