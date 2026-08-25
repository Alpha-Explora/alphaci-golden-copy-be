import { Global, Injectable, Module } from '@nestjs/common';

import { DatabaseModule } from '../../kernel/db/database.module';
import {
  type DeploymentProjectReference,
  type DeploymentProjectReferenceLookup,
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
} from '../deployments/index.js';
import { ProjectsRepository } from './projects.repository';

@Injectable()
class ProjectReferenceLookupAdapter
  implements DeploymentProjectReferenceLookup
{
  constructor(private readonly projectsRepository: ProjectsRepository) {}

  async findProjectReference(
    projectId: string,
    userId: string,
  ): Promise<DeploymentProjectReference | null> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    return project
      ? {
          projectId: project.id,
          userId,
          repoFullName: project.repo_full_name,
          repoUrl: project.repo_url,
          workflowPath: project.workflow_path,
          projectOptions: project.project_options,
        }
      : null;
  }
}

/**
 * Composition-only ACL: Projects owns the repository and supplies the small
 * reference contract that Deployments needs for provider calls. Deployments
 * does not import this module; the root application wires it globally.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    ProjectsRepository,
    ProjectReferenceLookupAdapter,
    {
      provide: DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
      useExisting: ProjectReferenceLookupAdapter,
    },
  ],
  exports: [DEPLOYMENT_PROJECT_REFERENCE_LOOKUP],
})
export class ProjectReferenceModule {}
