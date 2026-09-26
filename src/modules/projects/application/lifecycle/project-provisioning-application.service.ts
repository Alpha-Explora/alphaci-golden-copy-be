import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';

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
    await this.support.assertWithinQuota(userId, 'projects', 1, null);
    const workspaceId =
      await this.support.workspaceGate.resolveWorkspaceIdForCreate(
        userId,
        dto.workspaceId,
      );

    // Validated before resolveRepositoryProvisioning below (the first call
    // that can reach GitHub) — a deliveryProjectId rejected after the repo
    // already exists would strand it.
    if (dto.deliveryProjectId) {
      await this.support.assertDeliveryProjectAvailableForCreate({
        deliveryProjectId: dto.deliveryProjectId,
        workspaceId,
        userId,
      });
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

    return this.singleRepository.createStandaloneProject(
      userId,
      userLogin,
      repositoryCreationToken,
      provisioningToken,
      provisioningOwnerLogin,
      dto,
    );
  }

  async setupProject(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    // Same ordering as createProject: validated before the setup flow's first
    // GitHub call (resolveSetupProvisioningToken).
    if (dto.deliveryProjectId) {
      const workspaceId =
        await this.support.workspaceGate.resolveWorkspaceIdForCreate(
          userId,
          dto.workspaceId,
        );
      await this.support.assertDeliveryProjectAvailableForCreate({
        deliveryProjectId: dto.deliveryProjectId,
        workspaceId,
        userId,
      });
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
