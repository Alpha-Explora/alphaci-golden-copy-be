import { Global, Injectable, Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import {
  type DeploymentProjectEnvironment,
  type DeploymentProjectReference,
  type DeploymentProjectReferenceLookup,
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
} from '#kernel/ports/deployment-runtime.port';
import { ProjectsRepository } from './infrastructure/projects.repository';
import { scaffoldRuntimeContract } from './scaffold.builder';

@Injectable()
class ProjectReferenceLookupAdapter implements DeploymentProjectReferenceLookup {
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
          // Only a repository AlphaCI scaffolded records a project type. Each
          // row of a two-repository project has its own, so each gets its
          // own slot's contract.
          serviceRuntime: scaffoldRuntimeContract(project.project_type_id),
        }
      : null;
  }

  async findProjectEnvironment(
    projectId: string,
    environmentId: string,
  ): Promise<DeploymentProjectEnvironment | null> {
    const environments = await this.listProjectEnvironments(projectId);
    return environments.find(({ id }) => id === environmentId) ?? null;
  }

  async listProjectEnvironments(
    projectId: string,
  ): Promise<DeploymentProjectEnvironment[]> {
    const environments =
      await this.projectsRepository.listProjectEnvironments(projectId);
    return environments.map((environment) => ({
      id: environment.id,
      slug: environment.slug,
      sourceBranch: environment.sourceBranch,
      role: environment.role,
      position: environment.position,
    }));
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
