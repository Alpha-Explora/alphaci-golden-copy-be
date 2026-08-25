import { Injectable } from '@nestjs/common';

import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../projects.repository';

/**
 * The narrow write contract hierarchy needs when it creates a repository-backed
 * project. The projects database row and repository remain private to Projects;
 * hierarchy receives only the durable project identity it links to.
 */
export interface CreateHierarchyManagedProjectInput {
  userId: string;
  repoFullName: string;
  serviceName: string;
  repoUrl: string;
  workspaceId: string;
}

export interface CreatedProjectReference {
  id: string;
}

@Injectable()
export class ProjectProvisioningService {
  constructor(private readonly projectsRepository: ProjectsRepository) {}

  async createHierarchyManagedProject(
    input: CreateHierarchyManagedProjectInput,
  ): Promise<CreatedProjectReference> {
    const row: ProvisionedProjectRow = await this.projectsRepository.create({
      userId: input.userId,
      repoFullName: input.repoFullName,
      templateId: 'hierarchy-managed',
      serviceName: input.serviceName,
      workflowPath: '',
      status: 'provisioned',
      repoUrl: input.repoUrl,
      visibility: 'private',
      workspaceId: input.workspaceId,
    });

    return { id: row.id };
  }
}
