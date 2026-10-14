import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { canManageHosting } from '#kernel/rules/persona-access.rules';
import { ProjectsRepository } from '../infrastructure/projects.repository';
import { validateProjectEnvironmentDefinition } from '../domain/project-environment.policy';
import type {
  ProjectEnvironmentInput,
  ProjectEnvironmentRecord,
} from '../domain/project-environment.policy';

@Injectable()
export class ProjectEnvironmentsService {
  constructor(private readonly projectsRepository: ProjectsRepository) {}

  async list(
    projectId: string,
    userId: string,
  ): Promise<ProjectEnvironmentRecord[]> {
    await this.findVisibleProject(projectId, userId);
    return this.projectsRepository.listProjectEnvironments(projectId);
  }

  async add(
    projectId: string,
    userId: string,
    input: ProjectEnvironmentInput,
  ): Promise<ProjectEnvironmentRecord> {
    await this.assertProjectMutationAccess(projectId, userId);
    await this.findVisibleProject(projectId, userId);
    const environments =
      await this.projectsRepository.listProjectEnvironments(projectId);

    if (environments.length === 0 && input.role !== 'production') {
      throw new BadRequestException(
        'The first environment added to a legacy project must have the production role.',
      );
    }
    if (
      environments.some((environment) => environment.role === 'production') &&
      input.role === 'production'
    ) {
      throw new BadRequestException(
        'A project can have exactly one production environment.',
      );
    }

    const violation = validateProjectEnvironmentDefinition(input);
    if (violation) {
      throw new BadRequestException(
        'Invalid environment: ' + violation.replaceAll('_', ' '),
      );
    }

    try {
      return await this.projectsRepository.appendProjectEnvironment(
        projectId,
        input,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Environment slug or position is already in use. Reload the list and retry.',
        );
      }
      throw error;
    }
  }

  async rename(
    projectId: string,
    environmentId: string,
    userId: string,
    displayName: string,
  ): Promise<ProjectEnvironmentRecord> {
    await this.assertProjectMutationAccess(projectId, userId);
    await this.findVisibleProject(projectId, userId);
    if (!displayName.trim()) {
      throw new BadRequestException('Display name must not be blank.');
    }
    const environment = await this.projectsRepository.renameProjectEnvironment(
      projectId,
      environmentId,
      displayName,
    );
    if (!environment) throw new NotFoundException('Environment not found');
    return environment;
  }

  private async findVisibleProject(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) throw new NotFoundException('Project not found');
  }

  private async assertProjectMutationAccess(
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.findVisibleProject(projectId, userId);
    const role = await this.projectsRepository.findAppRole(userId);
    if (!canManageHosting(role)) {
      throw new ForbiddenException(
        'Only Developers and admins can change environments.',
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
