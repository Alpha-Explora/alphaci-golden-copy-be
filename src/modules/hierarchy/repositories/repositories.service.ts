import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventsService } from '../../audit/index.js';
import { GithubService } from '../../github/index.js';
import { ProjectProvisioningService } from '../../projects/index.js';
import { DeliveryProjectsRepository } from '../delivery-projects/delivery-projects.repository';
import { HierarchyAccessService } from '../hierarchy-access.service';
import { HIERARCHY_EVENT_CODES } from '../hierarchy.types';
import {
  RepositoriesRepository,
  type RepositoryRecord,
} from './repositories.repository';
import type { CreateRepositoryDto } from '../dto/create-repository.dto';
import type { UpdateRepositoryDto } from '../dto/update-repository.dto';

@Injectable()
export class RepositoriesService {
  constructor(
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly deliveryProjectsRepository: DeliveryProjectsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly githubService: GithubService,
    private readonly projectProvisioningService: ProjectProvisioningService,
    private readonly auditEventsService: AuditEventsService,
  ) {}

  /**
   * Creates the GitHub repository (reuses GithubService.createRepo — does
   * not reimplement GitHub repo creation, plan §1.5), the hierarchy record,
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
      await this.projectProvisioningService.createHierarchyManagedProject({
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
      // hierarchy identifiers otherwise live in metadata only (plan §2.2
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
