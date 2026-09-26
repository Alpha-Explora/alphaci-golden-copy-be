import { Injectable } from '@nestjs/common';
import type {
  CreateHierarchyManagedProjectInput,
  ProjectLookupPort,
  WorkspaceProjectRole,
  WorkspaceProjectSummary,
} from '#kernel/ports/project-lookup.port';

import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../../infrastructure/projects.repository';
import { normalizeRepoShape } from '../../scaffold.builder';
import { CatalogService } from '../catalog/catalog.service';

/**
 * The narrow write contract hierarchy needs when it creates a repository-backed
 * project. The projects database row and repository remain private to Projects;
 * hierarchy receives only the durable project identity it links to.
 */
export interface CreatedProjectReference {
  id: string;
}

@Injectable()
export class ProjectProvisioningService implements ProjectLookupPort {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly catalogService: CatalogService,
  ) {}

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

  async listWorkspaceProjects(
    workspaceId: string,
  ): Promise<WorkspaceProjectSummary[]> {
    const rows =
      await this.projectsRepository.listWorkspaceProjectSummaries(workspaceId);
    const kindByType = new Map(
      this.catalogService
        .getProjectOptions()
        .projectTypes.map((type) => [type.id, type.kind]),
    );

    return rows.map((row) => ({
      id: row.id,
      name:
        row.service_name?.trim() ||
        row.repo_name?.trim() ||
        row.repo_full_name?.split('/')[1] ||
        row.id,
      repoFullName: row.repo_full_name,
      role: projectRole(
        row.repo_shape,
        row.project_type_id ? kindByType.get(row.project_type_id) : undefined,
      ),
      status: row.status,
      repoShape: row.repo_shape,
    }));
  }
}

/**
 * Only a multi-repo project splits into a frontend and a backend repository,
 * and which one a row is comes from its declared stack kind (ADR-0006).
 */
export function projectRole(
  repoShape: string | null,
  stackKind: 'frontend' | 'backend' | undefined,
): WorkspaceProjectRole {
  const shape = normalizeRepoShape(repoShape);
  if (shape === 'microservices') return 'service';
  if (shape === 'multi-repo' && stackKind) return stackKind;
  return 'app';
}
