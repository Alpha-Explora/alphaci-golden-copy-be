import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  DEPLOYMENT_TARGETS_QUERY,
  type DeploymentTargetsQuery,
} from '#kernel/ports/deployment-runtime.port';
import {
  PROJECT_LINK_PORT,
  type ProjectFolderLink,
  type ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import { QaAccessService } from './qa-access.service';

/** A repository of the Project that is linked to a provisioned (AlphaCI) project. */
export interface QaProjectRepository {
  projectId: string;
  name: string;
  repoFullName: string;
}

export interface QaProjectContext {
  deliveryProjectId: string;
  groupId: string;
  name: string;
  /** Linked repositories only, oldest first: the ones a Project run can cover. */
  repositories: QaProjectRepository[];
}

/**
 * Resolves a Project (hierarchy delivery project) for the QA slices through
 * PROJECT_LINK_PORT - never inline SQL on hierarchy.* - and applies the one
 * visibility rule: the caller must be an active member of the Project's group
 * (QaAccessService.canAccessWorkspace), otherwise it does not exist for them
 * (404, never a 403 that would confirm it).
 */
@Injectable()
export class QaProjectContextService {
  private readonly logger = new Logger(QaProjectContextService.name);

  constructor(
    private readonly access: QaAccessService,
    @Inject(PROJECT_LINK_PORT)
    private readonly projectLink: ProjectLinkPort,
    @Inject(DEPLOYMENT_TARGETS_QUERY)
    private readonly deploymentTargets: DeploymentTargetsQuery,
  ) {}

  /** 404 when the Project does not exist or the caller is not in its group. */
  async requireProject(
    deliveryProjectId: string,
    userId: string,
  ): Promise<QaProjectContext> {
    const folder = await this.projectLink.getDeliveryProject(deliveryProjectId);
    if (
      !folder ||
      !(await this.access.canAccessWorkspace(userId, folder.groupId))
    ) {
      throw new NotFoundException('Project not found');
    }
    return this.toContext(folder);
  }

  /** Same lookup without the caller check, for work that is already authorized (cleanup, notifications). */
  async findProject(
    deliveryProjectId: string,
  ): Promise<QaProjectContext | null> {
    const folder = await this.projectLink.getDeliveryProject(deliveryProjectId);
    return folder ? this.toContext(folder) : null;
  }

  /** The Project a repository is filed under, or null when it is unfiled. */
  async findProjectOfRepository(
    projectId: string,
  ): Promise<QaProjectContext | null> {
    const folder = await this.projectLink.getProjectFolder(projectId);
    return folder ? this.toContext(folder) : null;
  }

  /** The active Projects of a group, for the team-level overview. */
  listGroupProjects(
    groupId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return this.projectLink.listDeliveryProjectsForGroup(groupId);
  }

  /**
   * The repository a Project-level notification or audit event is anchored
   * to (design doc 6.3 decision 5): the Project's repository with a
   * `frontend` deployment target, oldest first; with none, its oldest linked
   * repository. Null only when the Project has no linked repository.
   */
  async anchorProjectId(project: QaProjectContext): Promise<string | null> {
    if (project.repositories.length === 0) {
      return null;
    }
    const slots = await Promise.all(
      project.repositories.map(async (repository) => {
        try {
          const targets = await this.deploymentTargets.listDeploymentTargets(
            repository.projectId,
          );
          return targets.some((target) => target.slot === 'frontend');
        } catch (error) {
          this.logger.debug(
            `Could not read deployment targets of ${repository.repoFullName}: ${String(error)}`,
          );
          return false;
        }
      }),
    );
    const frontend = project.repositories.find((_, index) => slots[index]);
    return (frontend ?? project.repositories[0])?.projectId ?? null;
  }

  private toContext(folder: ProjectFolderLink): QaProjectContext {
    return {
      deliveryProjectId: folder.deliveryProjectId,
      groupId: folder.groupId,
      name: folder.name,
      repositories: folder.repositories.flatMap((repository) =>
        repository.projectId && repository.repoFullName
          ? [
              {
                projectId: repository.projectId,
                name: repository.name,
                repoFullName: repository.repoFullName,
              },
            ]
          : [],
      ),
    };
  }
}
