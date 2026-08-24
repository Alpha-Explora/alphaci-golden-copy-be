import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditEventsService } from '../../audit/index.js';
import { HierarchyAccessService } from '../hierarchy-access.service';
import { HIERARCHY_EVENT_CODES } from '../hierarchy.types';
import {
  DeliveryProjectsRepository,
  type DeliveryProjectRecord,
} from './delivery-projects.repository';
import type { CreateDeliveryProjectDto } from '../dto/create-delivery-project.dto';
import type { UpdateDeliveryProjectDto } from '../dto/update-delivery-project.dto';

@Injectable()
export class DeliveryProjectsService {
  constructor(
    private readonly deliveryProjectsRepository: DeliveryProjectsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly auditEventsService: AuditEventsService,
  ) {}

  async createDeliveryProject(
    systemId: string,
    userId: string,
    dto: CreateDeliveryProjectDto,
  ): Promise<DeliveryProjectRecord> {
    const { groupId } = await this.accessService.assertCanCreateUnderSystem(
      systemId,
      userId,
    );
    const deliveryProject = await this.deliveryProjectsRepository.create({
      systemId,
      groupId,
      name: dto.name,
      description: dto.description ?? null,
      managerId: userId,
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.deliveryProjectCreated,
      message: `Delivery project "${deliveryProject.name}" created`,
      metadata: { groupId, systemId, deliveryProjectId: deliveryProject.id },
    });

    return deliveryProject;
  }

  async listDeliveryProjects(
    systemId: string,
    userId: string,
  ): Promise<DeliveryProjectRecord[]> {
    await this.accessService.assertSystemMembership(systemId, userId);
    return this.deliveryProjectsRepository.listBySystem(systemId);
  }

  async getDeliveryProject(
    deliveryProjectId: string,
    userId: string,
  ): Promise<DeliveryProjectRecord> {
    await this.accessService.assertDeliveryProjectMembership(
      deliveryProjectId,
      userId,
    );
    const deliveryProject =
      await this.deliveryProjectsRepository.findById(deliveryProjectId);
    if (!deliveryProject) {
      throw new NotFoundException('Delivery project not found');
    }
    return deliveryProject;
  }

  async updateDeliveryProject(
    deliveryProjectId: string,
    userId: string,
    dto: UpdateDeliveryProjectDto,
  ): Promise<DeliveryProjectRecord> {
    const { groupId } = await this.accessService.assertDeliveryProjectManager(
      deliveryProjectId,
      userId,
    );
    const deliveryProject = await this.deliveryProjectsRepository.update(
      deliveryProjectId,
      dto,
    );
    if (!deliveryProject) {
      throw new NotFoundException('Delivery project not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.deliveryProjectUpdated,
      message: `Delivery project "${deliveryProject.name}" updated`,
      metadata: { groupId, deliveryProjectId },
    });

    return deliveryProject;
  }

  async archiveDeliveryProject(
    deliveryProjectId: string,
    userId: string,
  ): Promise<DeliveryProjectRecord> {
    const { groupId } = await this.accessService.assertDeliveryProjectManager(
      deliveryProjectId,
      userId,
    );
    const deliveryProject =
      await this.deliveryProjectsRepository.archive(deliveryProjectId);
    if (!deliveryProject) {
      throw new NotFoundException('Delivery project not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.deliveryProjectArchived,
      message: `Delivery project "${deliveryProject.name}" archived`,
      metadata: { groupId, deliveryProjectId },
    });

    return deliveryProject;
  }
}
