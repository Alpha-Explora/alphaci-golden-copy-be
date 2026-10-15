import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ONPREM_ASSIGNMENT,
  type OnpremAssignmentPort,
} from '#kernel/ports/onprem-assignment.port';

import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  CI_PROJECT_PORT,
  type CiProjectPort,
} from '#kernel/ports/ci-project.port';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  PROJECT_LINK_PORT,
  type ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import {
  USAGE_QUOTA,
  type UsageQuotaPort,
} from '#kernel/ports/usage-quota.port';
import {
  WORKSPACES_PORT,
  type WorkspacesPort,
} from '#kernel/ports/workspaces.port';
import {
  DEPLOYMENT_PROVISIONING_FACADE,
  DEPLOYMENT_PROVISIONING_DEFAULTS,
  type DeploymentProvisioningFacade,
  type DeploymentProvisioningDefaultsPort,
} from '#kernel/ports/deployment-runtime.port';
import { CatalogService } from '../catalog/catalog.service';
import {
  ProjectProvisioningSupport,
  type WorkflowFilePusher,
} from './project-provisioning.support';
import { SingleRepositoryProjectProvisioner } from './single-repository-project.provisioner';
import { MicroservicesProjectProvisioner } from './microservices-project.provisioner';
import { MultiRepositoryProjectProvisioner } from './multi-repository-project.provisioner';
import { normalizeRepoShape } from '../../scaffold.builder';
import type { CreateProjectDto } from '../../api/dto/create-project.dto';
import type { SetupProjectDto } from '../../api/dto/setup-project.dto';
import type {
  CreateProjectResponse,
  SetupProjectResponse,
} from './projects.service.types';
import {
  PROJECT_REQUIREMENTS_READINESS,
  type ProjectRequirementsReadinessPort,
} from '#kernel/ports/project-requirements-readiness.port';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { validateProjectEnvironmentDefinitions } from '../../domain/project-environment.policy';
import { environmentTargetsProblem } from '../../domain/environment-deployment-targets.policy';

export type * from './projects.service.types';

/**
 * Dispatches project provisioning requests to focused use-case services.
 *
 * The ordering inside each flow lives in the corresponding provisioner. This
 * class owns only the shared preflight (quota, workspace, token, and shape)
 * and the public application boundary used by ProjectsService.
 */
@Injectable()
export class ProjectProvisioningApplicationService {
  private readonly support: ProjectProvisioningSupport;
  private readonly singleRepository: SingleRepositoryProjectProvisioner;
  private readonly microservices: MicroservicesProjectProvisioner;
  private readonly multiRepository: MultiRepositoryProjectProvisioner;

  constructor(
    @Inject(CatalogService)
    catalogService: CatalogService,
    @Inject(GITHUB_PROJECT_PORT)
    githubService: GithubProjectPort,
    @Inject(ProjectsRepository)
    projectsRepository: ProjectsRepository,
    @Inject(CI_PROJECT_PORT)
    ciService: CiProjectPort,
    @Inject(DEPLOYMENT_PROVISIONING_FACADE)
    projectDeploymentProvisioningService: DeploymentProvisioningFacade,
    @Optional()
    configService?: ConfigService,
    @Optional()
    @Inject(USAGE_QUOTA)
    usageQuotaService?: UsageQuotaPort,
    @Optional()
    auditEventsService?: AuditEventPublisher,
    @Optional()
    @Inject(WORKSPACES_PORT)
    workspacesService?: WorkspacesPort,
    @Optional()
    notificationEventPublisher?: NotificationEventPublisher,
    @Optional()
    auditEventPublisher?: AuditEventPublisher,
    @Optional()
    @Inject(PROJECT_LINK_PORT)
    hierarchyProjectLinkService?: ProjectLinkPort,
    @Optional()
    workflowFilePusher?: WorkflowFilePusher,
    @Optional()
    workflowFragmentRegistry?: WorkflowFragmentRegistry,
    @Optional()
    @Inject(DEPLOYMENT_PROVISIONING_DEFAULTS)
    deploymentProvisioningDefaults?: DeploymentProvisioningDefaultsPort,
    // Last, like every positional collaborator: ProjectsService and the specs
    // construct this class by hand. Without @Inject an @Optional dep is
    // undefined; the gate then fails closed for a Developer.
    @Optional()
    @Inject(PROJECT_REQUIREMENTS_READINESS)
    requirementsReadiness?: ProjectRequirementsReadinessPort,
    @Optional()
    @Inject(ONPREM_ASSIGNMENT)
    private readonly onpremAssignment?: OnpremAssignmentPort,
  ) {
    this.support = new ProjectProvisioningSupport({
      catalogService,
      githubService,
      projectsRepository,
      ciService,
      projectDeploymentProvisioningService,
      deploymentProvisioningDefaults,
      configService,
      usageQuotaService,
      auditEventsService,
      workspacesService,
      notificationEventPublisher,
      auditEventPublisher,
      hierarchyProjectLinkService,
      workflowFilePusher,
      workflowFragmentRegistry,
      requirementsReadiness,
    });
    this.singleRepository = new SingleRepositoryProjectProvisioner(
      this.support,
    );
    this.microservices = new MicroservicesProjectProvisioner(this.support);
    this.multiRepository = new MultiRepositoryProjectProvisioner(this.support);
  }

  async createProject(
    userId: string,
    userLogin: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    if (dto.environments) {
      const violation = validateProjectEnvironmentDefinitions(dto.environments);
      if (violation) {
        throw new BadRequestException(
          'Invalid project environments: ' + violation.replaceAll('_', ' '),
        );
      }
      const shape = normalizeRepoShape(dto.repoShape);
      if (shape === 'microservices' || shape === 'multi-repo') {
        throw new BadRequestException(
          'Custom project environments are supported for single-repository projects. Create a ' +
            shape +
            ' project without an environments list for now.',
        );
      }
    }
    const targetsProblem = environmentTargetsProblem(
      dto.environments,
      dto.deploymentProvisioning?.targets ?? [],
      (provider) =>
        this.support.workflowFragmentRegistry?.deliveredByHost(provider) ??
        false,
    );
    if (targetsProblem) throw new BadRequestException(targetsProblem);
    await this.support.assertWithinQuota(userId, 'projects', 1, null);
    const workspaceId =
      await this.support.workspaceGate.resolveWorkspaceIdForCreate(
        userId,
        dto.workspaceId,
        dto.deliveryProjectId,
        // The Feature rule runs below, after the Project is known to exist,
        // belong to the team and be available (no 409-vs-404 side channel).
        { requireFeatures: false },
      );

    // Same ordering rule for a caller-chosen Project name: 409 before GitHub.
    await this.support.assertProjectNameAvailableForCreate({
      projectName: dto.projectName,
      deliveryProjectId: dto.deliveryProjectId,
      workspaceId,
    });

    // Validated before resolveRepositoryProvisioning below (the first call
    // that can reach GitHub) — a deliveryProjectId rejected after the repo
    // already exists would strand it.
    if (dto.deliveryProjectId) {
      await this.support.assertDeliveryProjectAvailableForCreate({
        deliveryProjectId: dto.deliveryProjectId,
        workspaceId,
        userId,
      });
      // Still before the first GitHub call (resolveRepositoryProvisioning).
      await this.support.workspaceGate.assertProjectHasFeatures(
        userId,
        dto.deliveryProjectId,
      );
    }

    const {
      repositoryCreationToken,
      provisioningToken,
      provisioningOwnerLogin,
    } = await this.support.resolveRepositoryProvisioning(
      userId,
      accessToken,
      dto,
    );

    const repoShape = normalizeRepoShape(dto.repoShape);
    if (repoShape === 'microservices') {
      return this.microservices.createMicroservicesProject(
        userId,
        userLogin,
        repositoryCreationToken,
        provisioningToken,
        provisioningOwnerLogin,
        dto,
      );
    }

    if (repoShape === 'multi-repo') {
      return this.multiRepository.createMultiRepoProject(
        userId,
        userLogin,
        repositoryCreationToken,
        provisioningToken,
        provisioningOwnerLogin,
        dto,
      );
    }

    const created = await this.singleRepository.createStandaloneProject(
      userId,
      userLogin,
      repositoryCreationToken,
      provisioningToken,
      provisioningOwnerLogin,
      dto,
    );
    const selected = dto.environments?.filter(
      (environment) => environment.hostAssignment,
    );
    if (!selected?.length) return created;
    const environments = await this.support.projectsRepository
      .listProjectEnvironments(created.id)
      .catch(() => null);
    if (!environments)
      return {
        ...created,
        hostAssignmentError:
          'Project created. Host assignments could not be read. Open Hosting to assign the existing environments.',
      };
    const hostAssignments: NonNullable<
      CreateProjectResponse['hostAssignments']
    > = [];
    for (const definition of selected) {
      const environment = environments.find(
        (item) => item.slug === definition.slug,
      );
      if (!environment)
        return {
          ...created,
          hostAssignments,
          hostAssignmentError:
            'Project created. An environment was unavailable for host assignment. Open Hosting to retry.',
        };
      try {
        if (!this.onpremAssignment)
          throw new Error('Host assignment is unavailable.');
        const result = await this.onpremAssignment.assignProvisionedEnvironment(
          created.id,
          environment.id,
          userId,
          definition.hostAssignment!,
        );
        hostAssignments.push({
          environmentId: environment.id,
          status: 'assigned',
          assignmentId: result.assignmentId,
        });
      } catch (error) {
        // The repository already exists. Keep it usable and retry through the
        // existing environment's explicit assignment endpoint, never create again.
        hostAssignments.push({
          environmentId: environment.id,
          status: 'failed',
          message:
            error instanceof HttpException
              ? `Project created. Host assignment failed: ${error.message}`
              : 'Project created. Assign or retry the host from this environment in Hosting.',
        });
      }
    }
    return { ...created, hostAssignments };
  }

  async setupProject(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    // Same ordering as createProject: validated before the setup flow's first
    // GitHub call (resolveSetupProvisioningToken).
    if (dto.deliveryProjectId || dto.projectName) {
      const workspaceId =
        await this.support.workspaceGate.resolveWorkspaceIdForCreate(
          userId,
          dto.workspaceId,
          dto.deliveryProjectId,
          { requireFeatures: false },
        );
      await this.support.assertProjectNameAvailableForCreate({
        projectName: dto.projectName,
        deliveryProjectId: dto.deliveryProjectId,
        workspaceId,
      });
      if (dto.deliveryProjectId) {
        await this.support.assertDeliveryProjectAvailableForCreate({
          deliveryProjectId: dto.deliveryProjectId,
          workspaceId,
          userId,
        });
        await this.support.workspaceGate.assertProjectHasFeatures(
          userId,
          dto.deliveryProjectId,
        );
      }
    }

    return this.singleRepository.setupProject(userId, oauthAccessToken, dto);
  }

  buildWorkflowYaml(
    templateId: string,
    serviceName: string,
    servicePath?: string,
    nodeVersion?: string,
    coverageThreshold?: number,
    customOutputFileName?: string,
    enhancements?: Array<
      | 'strictProductionApproval'
      | 'enableUatApproval'
      | 'disablePlaywright'
      | 'disableK6'
    >,
  ): Promise<{ generatedYaml: string; outputFileName: string }> {
    return this.support.buildWorkflowYaml(
      templateId,
      serviceName,
      servicePath,
      nodeVersion,
      coverageThreshold,
      customOutputFileName,
      enhancements,
    );
  }
}
