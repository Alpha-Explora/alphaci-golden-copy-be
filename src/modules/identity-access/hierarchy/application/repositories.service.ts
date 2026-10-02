import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  PROJECT_LOOKUP,
  type ProjectLookupPort,
} from '#kernel/ports/project-lookup.port';
import {
  PROJECT_REQUIREMENTS_READINESS,
  type ProjectRequirementsReadinessPort,
} from '#kernel/ports/project-requirements-readiness.port';
import { assertProjectHasFeatureForRepositoryCreate } from '#kernel/rules/project-features.gate';
import { DeliveryProjectsRepository } from '../infrastructure/delivery-projects.repository';
import { HierarchyAccessService } from './hierarchy-access.service';
import { HIERARCHY_EVENT_CODES } from '../domain/hierarchy.types';
import {
  RepositoriesRepository,
  type RepositoryRecord,
} from '../infrastructure/repositories.repository';
import type { CreateRepositoryDto } from '../api/dto/create-repository.dto';
import type { UpdateRepositoryDto } from '../api/dto/update-repository.dto';

export interface MoveRepositoryResult {
  repository: RepositoryRecord;
  /** False when the repository was already in the target project. */
  moved: boolean;
  sourceDeliveryProjectId: string;
  /** True when the move left the source project with no active repositories. */
  sourceDeliveryProjectEmpty: boolean;
}

@Injectable()
export class RepositoriesService {
  constructor(
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly deliveryProjectsRepository: DeliveryProjectsRepository,
    private readonly accessService: HierarchyAccessService,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    @Inject(PROJECT_LOOKUP)
    private readonly projectLookup: ProjectLookupPort,
    private readonly auditEventsService: AuditEventPublisher,
    @Inject(PROJECT_REQUIREMENTS_READINESS)
    private readonly requirementsReadiness: ProjectRequirementsReadinessPort,
  ) {}

  /**
   * Creates the GitHub repository (reuses GithubService.createRepo — does
   * not reimplement GitHub repo creation, the hierarchy record,
   * and a projects.provisioned_projects row wired to it so the repository
   * immediately gets dashboard/CI/deployment functionality for free.
   */
  async createRepository(
    deliveryProjectId: string,
    userId: string,
    githubAccessToken: string | undefined,
    dto: CreateRepositoryDto,
  ): Promise<RepositoryRecord> {
    const { groupId } =
      await this.accessService.assertCanCreateUnderDeliveryProject(
        deliveryProjectId,
        userId,
      );
    // A Developer files a repository only once a Product owner wrote a Feature
    // in the Project. Before any GitHub call. Platform admins are exempt.
    if (!(await this.accessService.isPlatformAdmin(userId))) {
      await assertProjectHasFeatureForRepositoryCreate(
        this.requirementsReadiness,
        await this.accessService.getAppRole(userId),
        deliveryProjectId,
      );
    }
    if (!githubAccessToken) {
      throw new BadRequestException(
        'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      );
    }

    const { repoUrl, ownerLogin, repoName } =
      await this.githubService.createRepo(githubAccessToken, {
        repoName: dto.name,
        private: true,
      });
    const repoFullName = `${ownerLogin}/${repoName}`;

    const provisionedProject =
      await this.projectLookup.createHierarchyManagedProject({
        userId,
        repoFullName,
        serviceName: repoName,
        repoUrl,
        workspaceId: groupId,
      });

    const repository = await this.repositoriesRepository.create({
      deliveryProjectId,
      groupId,
      name: dto.name,
      repoFullName,
      createdBy: userId,
      provisionedProjectId: provisionedProject.id,
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.repositoryCreated,
      message: `Repository "${repository.name}" created`,
      // provisionedProject.id is safe to set as projectId (real FK target);
      // hierarchy identifiers otherwise live in metadata only (hierarchy persistence contract
      // critical note — a repository with no provisioned_project_id link
      // cannot be passed as projectId, but this one always has one).
      projectId: provisionedProject.id,
      metadata: { groupId, deliveryProjectId, repositoryId: repository.id },
    });

    return repository;
  }

  async listRepositories(
    deliveryProjectId: string,
    userId: string,
  ): Promise<RepositoryRecord[]> {
    if (await this.accessService.isPlatformAdmin(userId)) {
      return this.repositoriesRepository.listByDeliveryProjectForManager(
        deliveryProjectId,
      );
    }

    const groupId =
      await this.deliveryProjectsRepository.findGroupIdForDeliveryProject(
        deliveryProjectId,
      );
    if (!groupId) {
      throw new NotFoundException('Delivery project not found');
    }
    const membership = await this.accessService.assertGroupMembership(
      groupId,
      userId,
    );

    if (membership.role === 'admin' || membership.role === 'delegated_lead') {
      return this.repositoriesRepository.listByDeliveryProjectForManager(
        deliveryProjectId,
      );
    }
    return this.repositoriesRepository.listByDeliveryProjectForAssignee(
      deliveryProjectId,
      userId,
    );
  }

  async getRepository(
    repositoryId: string,
    userId: string,
  ): Promise<RepositoryRecord> {
    const { repository } = await this.accessService.assertRepositoryVisible(
      repositoryId,
      userId,
    );
    return repository;
  }

  async updateRepository(
    repositoryId: string,
    userId: string,
    dto: UpdateRepositoryDto,
  ): Promise<RepositoryRecord> {
    await this.accessService.assertRepositoryManagerOrPlatformAdmin(
      repositoryId,
      userId,
    );
    const repository = await this.repositoriesRepository.update(
      repositoryId,
      dto,
    );
    if (!repository) {
      throw new NotFoundException('Repository not found');
    }
    return repository;
  }

  /**
   * Moves a repository into another project of the same team. Only the
   * `hierarchy.repositories` row changes: access assignments hang off the
   * repository, so developers keep exactly the access they had.
   *
   * An emptied source project is left in place, not deleted — a lead may have
   * created it on purpose. `sourceDeliveryProjectEmpty` lets the UI offer to
   * archive it.
   */
  async moveRepository(
    repositoryId: string,
    userId: string,
    targetDeliveryProjectId: string,
  ): Promise<MoveRepositoryResult> {
    const { groupId } =
      await this.accessService.assertRepositoryManagerOrPlatformAdmin(
        repositoryId,
        userId,
      );
    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) {
      throw new NotFoundException('Repository not found');
    }
    if (repository.status === 'archived') {
      throw new BadRequestException('Archived repositories cannot be moved.');
    }

    const target = await this.deliveryProjectsRepository.findById(
      targetDeliveryProjectId,
    );
    // Another team's project answers exactly like a missing one, so a lead
    // cannot probe for project ids outside their own team.
    if (!target || target.groupId !== groupId) {
      throw new NotFoundException('Delivery project not found');
    }
    if (target.status === 'archived') {
      throw new BadRequestException(
        'Repositories cannot be moved into an archived project.',
      );
    }

    const sourceDeliveryProjectId = repository.deliveryProjectId;
    if (sourceDeliveryProjectId === target.id) {
      return {
        repository,
        moved: false,
        sourceDeliveryProjectId,
        sourceDeliveryProjectEmpty: false,
      };
    }

    const moved = await this.repositoriesRepository.moveToDeliveryProject(
      repositoryId,
      sourceDeliveryProjectId,
      target.id,
    );
    if (!moved) {
      throw new ConflictException(
        'This repository was moved by someone else. Refresh and try again.',
      );
    }

    const remaining =
      await this.repositoriesRepository.countActiveInDeliveryProject(
        sourceDeliveryProjectId,
      );

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.repositoryMoved,
      message: `Repository "${moved.name}" moved to project "${target.name}"`,
      ...(moved.provisionedProjectId
        ? { projectId: moved.provisionedProjectId }
        : {}),
      metadata: {
        groupId,
        repositoryId,
        fromDeliveryProjectId: sourceDeliveryProjectId,
        toDeliveryProjectId: target.id,
      },
    });

    return {
      repository: moved,
      moved: true,
      sourceDeliveryProjectId,
      sourceDeliveryProjectEmpty: remaining === 0,
    };
  }

  async archiveRepository(
    repositoryId: string,
    userId: string,
  ): Promise<RepositoryRecord> {
    const { groupId } =
      await this.accessService.assertRepositoryManagerOrPlatformAdmin(
        repositoryId,
        userId,
      );
    const repository = await this.repositoriesRepository.archive(repositoryId);
    if (!repository) {
      throw new NotFoundException('Repository not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.repositoryArchived,
      message: `Repository "${repository.name}" archived`,
      metadata: { groupId, repositoryId },
    });

    return repository;
  }
}
