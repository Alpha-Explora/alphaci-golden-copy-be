import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { DeliveryProjectsService } from './delivery-projects.service';
import { HierarchyAccessService } from './hierarchy-access.service';
import { HIERARCHY_EVENT_CODES } from '../domain/hierarchy.types';
import { RepositoriesService } from './repositories.service';
import type { RepositoryRecord } from '../infrastructure/repositories.repository';
import type { DeliveryProjectRecord } from '../infrastructure/delivery-projects.repository';
import {
  SystemsRepository,
  type SystemRecord,
} from '../infrastructure/systems.repository';
import type { CreateSystemDto } from '../api/dto/create-system.dto';
import type { CreateEmptyProjectDto } from '../api/dto/create-empty-project.dto';
import type { UpdateSystemDto } from '../api/dto/update-system.dto';

/**
 * Result of "create system". A system is the user-facing entry point for
 * provisioning a repository (product decision 2026-07-14): creating one
 * auto-creates the intermediate delivery project and a real GitHub repository,
 * so the response carries all three so the UI can link straight to the repo.
 */
export interface CreateSystemResult extends SystemRecord {
  deliveryProjectId: string;
  repository: RepositoryRecord;
}

@Injectable()
export class SystemsService {
  constructor(
    private readonly systemsRepository: SystemsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly auditEventsService: AuditEventPublisher,
    private readonly deliveryProjectsService: DeliveryProjectsService,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  /**
   * Creates a system AND provisions its repository in one step. Gated on the
   * GLOBAL creator role (Lead/Admin) via assertCanCreateInGroup — a group
   * 'member' (global role) cannot create even if they manage the group. The
   * GitHub token is validated up front (before any record is written) so a
   * missing token fails fast rather than leaving an empty system behind. The
   * per-step services re-assert the same global gate, keeping each safe on its
   * own; the redundant checks are cheap relative to the GitHub round-trip.
   */
  async createSystem(
    groupId: string,
    userId: string,
    githubAccessToken: string | undefined,
    dto: CreateSystemDto,
  ): Promise<CreateSystemResult> {
    await this.accessService.assertCanCreateInGroup(groupId, userId);

    // Fail fast before writing any record — a missing token otherwise leaves an
    // orphan system/delivery project once we reach repository creation.
    if (!githubAccessToken) {
      throw new BadRequestException(
        'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      );
    }

    const system = await this.systemsRepository.create({
      groupId,
      name: dto.name,
      description: dto.description ?? null,
      ownerId: userId,
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.systemCreated,
      message: `System "${system.name}" created`,
      metadata: { groupId, systemId: system.id },
    });

    // A system is the entry point for a repository: auto-create the
    // intermediate delivery project, then the GitHub repository itself. The
    // repository shares the system's name (the delivery project reuses it too),
    // so the user only names the thing once.
    const deliveryProject =
      await this.deliveryProjectsService.createDeliveryProject(
        system.id,
        userId,
        {
          name: dto.name,
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
        },
      );

    const repository = await this.repositoriesService.createRepository(
      deliveryProject.id,
      userId,
      githubAccessToken,
      { name: dto.name, visibility: 'private' },
    );

    return {
      ...system,
      // The count is 1 now that the delivery project exists (the create above
      // returned the pre-insert count of 0).
      deliveryProjectCount: 1,
      deliveryProjectId: deliveryProject.id,
      repository,
    };
  }

  /**
   * "Project folder" with no repository yet — a place to group future
   * repos before any exist. Otherwise identical to `createSystem`'s
   * system + delivery project auto-creation, minus the repository step:
   * same Lead/Admin/platform-admin gate, same audit trail for the system.
   * `createDeliveryProject` records its own `deliveryProjectCreated` event.
   */
  async createEmptyProject(
    groupId: string,
    userId: string,
    dto: CreateEmptyProjectDto,
  ): Promise<DeliveryProjectRecord> {
    await this.accessService.assertCanCreateInGroup(groupId, userId);

    // Same uniqueness rule as project creation (409 PROJECT_NAME_TAKEN),
    // re-checked under a per-(team, name) lock so two concurrent creates of
    // one name cannot both pass.
    return this.deliveryProjectsService.withProjectNameLock(
      groupId,
      dto.name,
      async () => {
        await this.deliveryProjectsService.assertProjectNameAvailable(
          groupId,
          dto.name,
        );
        return this.createEmptyProjectUnlocked(groupId, userId, dto);
      },
    );
  }

  private async createEmptyProjectUnlocked(
    groupId: string,
    userId: string,
    dto: CreateEmptyProjectDto,
  ): Promise<DeliveryProjectRecord> {
    const system = await this.systemsRepository.create({
      groupId,
      name: dto.name,
      description: dto.description ?? null,
      ownerId: userId,
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.systemCreated,
      message: `System "${system.name}" created`,
      metadata: { groupId, systemId: system.id },
    });

    return this.deliveryProjectsService.createDeliveryProject(
      system.id,
      userId,
      {
        name: dto.name,
        ...(dto.description !== undefined && { description: dto.description }),
      },
    );
  }

  async listSystems(groupId: string, userId: string): Promise<SystemRecord[]> {
    if (!(await this.accessService.isPlatformAdmin(userId))) {
      await this.accessService.assertGroupMembership(groupId, userId);
    }
    return this.systemsRepository.listByGroup(groupId);
  }

  async getSystem(systemId: string, userId: string): Promise<SystemRecord> {
    await this.accessService.assertSystemMembership(systemId, userId);
    const system = await this.systemsRepository.findById(systemId);
    if (!system) {
      throw new NotFoundException('System not found');
    }
    return system;
  }

  async updateSystem(
    systemId: string,
    userId: string,
    dto: UpdateSystemDto,
  ): Promise<SystemRecord> {
    const { groupId } = await this.accessService.assertSystemManager(
      systemId,
      userId,
    );
    const system = await this.systemsRepository.update(systemId, dto);
    if (!system) {
      throw new NotFoundException('System not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.systemUpdated,
      message: `System "${system.name}" updated`,
      metadata: { groupId, systemId },
    });

    return system;
  }

  async archiveSystem(systemId: string, userId: string): Promise<SystemRecord> {
    const { groupId } = await this.accessService.assertSystemManager(
      systemId,
      userId,
    );
    const system = await this.systemsRepository.archive(systemId);
    if (!system) {
      throw new NotFoundException('System not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.systemArchived,
      message: `System "${system.name}" archived`,
      metadata: { groupId, systemId },
    });

    return system;
  }
}
