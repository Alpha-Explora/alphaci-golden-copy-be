import { Inject, Injectable } from '@nestjs/common';

import {
  PROJECT_LOOKUP,
  type ProjectLookupPort,
  type WorkspaceProjectRole,
  type WorkspaceProjectSummary,
} from '#kernel/ports/project-lookup.port';
import {
  canCreateProjectFolder,
  canCreateRepository,
} from '#kernel/rules/persona-access.rules';
import type { AppRole } from '#modules/identity-access/admin/index.js';
import { GROUP_MANAGER_ROLES } from '../domain/hierarchy.types';
import type { RepositoryStatus } from '../domain/hierarchy.types';
import {
  ProjectFoldersRepository,
  type ProjectFolderRow,
} from '../infrastructure/project-folders.repository';
import { HierarchyAccessService } from './hierarchy-access.service';

export interface ProjectFolderRepository {
  repositoryId: string;
  name: string;
  repoFullName: string | null;
  status: RepositoryStatus;
  /** Null when the repository is not linked to an AlphaCI project. */
  project: {
    id: string;
    role: WorkspaceProjectRole;
    status: string;
    repoShape: string | null;
  } | null;
}

export interface ProjectFolder {
  deliveryProjectId: string;
  systemId: string;
  name: string;
  createdAt: string;
  repositories: ProjectFolderRepository[];
}

export interface UnfiledProject {
  id: string;
  name: string;
  repoFullName: string | null;
  role: WorkspaceProjectRole;
  status: string;
  repoShape: string | null;
}

export interface ProjectFoldersResult {
  groupId: string;
  /** Team lead, delegated lead or platform admin: may create, move and attach. */
  canManage: boolean;
  /** Persona may create a Project in this team (lead | admin). */
  canCreateProject: boolean;
  /**
   * Persona may create a repository (developer | admin). A developer always
   * files it into one of `folders`; only an admin may create without one.
   */
  canCreateRepository: boolean;
  folders: ProjectFolder[];
  /** Team projects with no hierarchy repository row at all. */
  unfiled: UnfiledProject[];
}

/**
 * The team's project explorer: every project (hierarchy delivery project)
 * with its repositories, plus the team's AlphaCI projects that are not filed
 * under any project. Readable by every active team member, like the team's
 * project list; projects belong to the whole team.
 */
@Injectable()
export class ProjectFoldersService {
  constructor(
    private readonly projectFoldersRepository: ProjectFoldersRepository,
    private readonly accessService: HierarchyAccessService,
    @Inject(PROJECT_LOOKUP)
    private readonly projectLookup: ProjectLookupPort,
  ) {}

  async listProjectFolders(
    groupId: string,
    userId: string,
  ): Promise<ProjectFoldersResult> {
    const canManage = await this.resolveCanManage(groupId, userId);
    const role = await this.resolvePersona(userId);

    const [rows, linkedProjectIds, projects] = await Promise.all([
      this.projectFoldersRepository.listFolderRows(groupId),
      this.projectFoldersRepository.listLinkedProjectIds(groupId),
      this.projectLookup.listWorkspaceProjects(groupId),
    ]);

    return {
      groupId,
      canManage,
      canCreateProject: canCreateProjectFolder(role),
      canCreateRepository: canCreateRepository(role),
      folders: groupFolders(rows, new Map(projects.map((p) => [p.id, p]))),
      unfiled: projects
        .filter((project) => !linkedProjectIds.has(project.id))
        .map((project) => ({
          id: project.id,
          name: project.name,
          repoFullName: project.repoFullName,
          role: project.role,
          status: project.status,
          repoShape: project.repoShape,
        })),
    };
  }

  /** Global persona; a platform admin is always 'admin'. */
  private async resolvePersona(userId: string): Promise<AppRole> {
    if (await this.accessService.isPlatformAdmin(userId)) return 'admin';
    return this.accessService.getAppRole(userId);
  }

  private async resolveCanManage(
    groupId: string,
    userId: string,
  ): Promise<boolean> {
    if (await this.accessService.isPlatformAdmin(userId)) {
      return true;
    }
    // Throws 404 for anyone who is not an active member of the team.
    const membership = await this.accessService.assertGroupMembership(
      groupId,
      userId,
    );
    return GROUP_MANAGER_ROLES.includes(membership.role);
  }
}

/** Folds the flat (project, repository) rows into ordered folders. */
export function groupFolders(
  rows: ProjectFolderRow[],
  projectsById: Map<string, WorkspaceProjectSummary>,
): ProjectFolder[] {
  const folders = new Map<string, ProjectFolder>();
  for (const row of rows) {
    let folder = folders.get(row.delivery_project_id);
    if (!folder) {
      folder = {
        deliveryProjectId: row.delivery_project_id,
        systemId: row.system_id,
        name: row.name,
        createdAt: row.created_at,
        repositories: [],
      };
      folders.set(row.delivery_project_id, folder);
    }
    if (!row.repository_id || !row.repository_status) continue;

    const project = row.provisioned_project_id
      ? projectsById.get(row.provisioned_project_id)
      : undefined;
    folder.repositories.push({
      repositoryId: row.repository_id,
      name: row.repository_name ?? row.repo_full_name ?? row.repository_id,
      repoFullName: row.repo_full_name,
      status: row.repository_status,
      project: project
        ? {
            id: project.id,
            role: project.role,
            status: project.status,
            repoShape: project.repoShape,
          }
        : null,
    });
  }
  return [...folders.values()];
}
