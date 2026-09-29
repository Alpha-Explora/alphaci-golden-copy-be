import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type {
  ProjectLifecycleDisconnectOptions,
  ProjectLifecycleDisconnectResult,
  ProjectLifecyclePort,
} from '#kernel/ports/project-lifecycle.port';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectLifecycleService } from './project-lifecycle.service';

/**
 * Implements PROJECT_LIFECYCLE_PORT for identity-access/hierarchy (see
 * project-lifecycle.port.ts for why the contract has no confirmRepoName
 * field). Registered by ProjectProvisioningModule, the existing @Global()
 * bridge that already carries PROJECT_LOOKUP/WORKSPACE_DATA_CLEANUP the same
 * way, so no module in identity-access needs to import this one.
 */
@Injectable()
export class ProjectLifecyclePortAdapter implements ProjectLifecyclePort {
  constructor(
    private readonly projectLifecycleService: ProjectLifecycleService,
    private readonly projectsRepository: ProjectsRepository,
  ) {}

  async disconnectProject(
    projectId: string,
    userId: string,
    options: ProjectLifecycleDisconnectOptions,
    githubAccessToken?: string | null,
  ): Promise<ProjectLifecycleDisconnectResult> {
    const deleteGithubRepo = options.deleteGithubRepo === true;

    // Only resolved when actually needed — disconnectProject's own
    // @ValidateIf only requires confirmRepoName when deleteGithubRepo=true,
    // and a caller here has no way to supply it themselves (see the port's
    // doc comment).
    const confirmRepoName = deleteGithubRepo
      ? (await this.projectsRepository.findByIdAndUser(projectId, userId))
          ?.repo_full_name
      : undefined;

    let result: Awaited<
      ReturnType<ProjectLifecycleService['disconnectProject']>
    >;
    try {
      result = await this.projectLifecycleService.disconnectProject(
        projectId,
        userId,
        {
          deleteGithubRepo,
          // exactOptionalPropertyTypes: omit the key entirely rather than set
          // it to undefined — DisconnectProjectDto declares it `confirmRepoName?:
          // string`, not `string | undefined`.
          ...(confirmRepoName !== undefined ? { confirmRepoName } : {}),
          deleteProviderResources: options.deleteProviderResources === true,
          deleteSonarProject: options.deleteSonarProject === true,
        },
        githubAccessToken,
      );
    } catch (error) {
      // disconnectProject answers 404 both when the project is gone and when
      // this user cannot see it. Only the first is an "already deleted" the
      // caller may skip; passing the second through as a 404 let a folder
      // delete drop the repository row and strand a live project (and its
      // GitHub repository) outside every folder.
      if (
        error instanceof NotFoundException &&
        (await this.projectsRepository.existsById(projectId))
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'PROJECT_DELETE_FORBIDDEN',
          message:
            'You do not have access to delete the AlphaCI project behind this repository. Ask a workspace admin or delegated lead.',
        });
      }
      throw error;
    }

    return { githubRepoDeleted: result.githubRepoDeleted };
  }
}
