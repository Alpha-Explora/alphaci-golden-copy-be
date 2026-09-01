import { Logger, UnprocessableEntityException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import type { CiProjectPort } from '#kernel/ports/ci-project.port';
import type { GithubProjectPort } from '#kernel/ports/github.port';
import type { ProjectLinkPort } from '#kernel/ports/project-link.port';
import type { UsageQuotaPort } from '#kernel/ports/usage-quota.port';
import type { WorkspacesPort } from '#kernel/ports/workspaces.port';
import type {
  DeploymentProvisioningFacade,
  DeploymentProvisioningDefaultsPort,
  DeploymentProvisioningResult,
} from '#kernel/ports/deployment-runtime.port';
import type { CatalogService } from '../catalog/catalog.service';
import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
  CreateProjectDto,
} from '../../dto/create-project.dto';
import type { ProjectsRepository } from '../../projects.repository';
import {
  filterDeploymentProvisioningRequest,
  forceManagedProvisioning,
  skippedDeploymentProvisioning,
} from './deployment-provisioning.policy';
import {
  buildProjectScaffold,
  defaultIncludeDocker,
} from '../../scaffold.builder';
import { buildGeneratedRepoReadme } from './generated-repo-readme';
import {
  SonarCloudSetupService,
  sonarProjectKeyFor,
} from './sonar-cloud-setup.service';
import { ProvisioningTokenService } from './provisioning-token.service';
import { SetupBranchService } from './setup-branch.service';
import { WorkspaceGateService } from './workspace-gate.service';
import { ProductEventsService } from './product-events.service';
import { ProjectWorkflowFilesService } from '../workflows/project-workflow-files.service';
import type {
  DeploymentWorkflowTarget,
  StagedWorkflowFile,
} from '../workflows/index';
import type { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';

export type WorkflowFilePusher = (
  accessToken: string,
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  commitMessage?: string,
  branch?: string,
) => Promise<{ commitSha: string; commitUrl: string | null }>;

export interface WorkflowBundleOptions {
  templateId: string;
  serviceName: string;
  servicePath?: string | undefined;
  nodeVersion?: string | undefined;
  coverageThreshold?: number | undefined;
  customOutputFileName?: string | undefined;
  enhancements?:
    | Array<
        | 'strictProductionApproval'
        | 'enableUatApproval'
        | 'disablePlaywright'
        | 'disableK6'
      >
    | undefined;
  deploymentProvider?: string | undefined;
  deploymentTargets?: DeploymentWorkflowTarget[] | undefined;
  workflowVariant?: 'backend' | 'frontend' | undefined;
  centralWorkflowRef?: string | undefined;
  hasTestsDirectory?: boolean | undefined;
}

/**
 * Shared provisioning mechanics for the three project-creation use cases.
 *
 * This is deliberately not a use-case coordinator: it owns only adapters,
 * compensation, event, workflow, and policy helpers that are common to the
 * standalone, microservices-shape, multi-repository, and setup flows. The
 * use-case classes own the ordering and business decisions.
 */
export class ProjectProvisioningSupport {
  private readonly logger = new Logger(ProjectProvisioningSupport.name);

  readonly catalogService: CatalogService;
  readonly githubService: GithubProjectPort;
  readonly projectsRepository: ProjectsRepository;
  readonly ciService: CiProjectPort;
  readonly projectDeploymentProvisioningService: DeploymentProvisioningFacade;
  readonly deploymentProvisioningDefaults:
    | DeploymentProvisioningDefaultsPort
    | undefined;
  readonly configService: ConfigService | undefined;
  readonly usageQuotaService: UsageQuotaPort | undefined;
  readonly auditEventsService: AuditEventPublisher | undefined;
  readonly workspacesService: WorkspacesPort | undefined;
  readonly notificationEventPublisher: NotificationEventPublisher | undefined;
  readonly auditEventPublisher: AuditEventPublisher | undefined;
  readonly hierarchyProjectLinkService: ProjectLinkPort | undefined;
  readonly workflowFilePusher: WorkflowFilePusher | undefined;
  readonly workflowFragmentRegistry: WorkflowFragmentRegistry | undefined;

  private sonarSetupLazy?: SonarCloudSetupService;
  private workflowFilesLazy?: ProjectWorkflowFilesService;
  private tokensLazy?: ProvisioningTokenService;
  private setupBranchLazy?: SetupBranchService;
  private workspaceGateLazy?: WorkspaceGateService;
  private productEventsLazy?: ProductEventsService;

  constructor(dependencies: {
    catalogService: CatalogService;
    githubService: GithubProjectPort;
    projectsRepository: ProjectsRepository;
    ciService: CiProjectPort;
    projectDeploymentProvisioningService: DeploymentProvisioningFacade;
    deploymentProvisioningDefaults:
      | DeploymentProvisioningDefaultsPort
      | undefined;
    configService: ConfigService | undefined;
    usageQuotaService: UsageQuotaPort | undefined;
    auditEventsService: AuditEventPublisher | undefined;
    workspacesService: WorkspacesPort | undefined;
    notificationEventPublisher: NotificationEventPublisher | undefined;
    auditEventPublisher: AuditEventPublisher | undefined;
    hierarchyProjectLinkService: ProjectLinkPort | undefined;
    workflowFilePusher: WorkflowFilePusher | undefined;
    workflowFragmentRegistry: WorkflowFragmentRegistry | undefined;
  }) {
    this.catalogService = dependencies.catalogService;
    this.githubService = dependencies.githubService;
    this.projectsRepository = dependencies.projectsRepository;
    this.ciService = dependencies.ciService;
    this.projectDeploymentProvisioningService =
      dependencies.projectDeploymentProvisioningService;
    this.deploymentProvisioningDefaults =
      dependencies.deploymentProvisioningDefaults;
    this.configService = dependencies.configService;
    this.usageQuotaService = dependencies.usageQuotaService;
    this.auditEventsService = dependencies.auditEventsService;
    this.workspacesService = dependencies.workspacesService;
    this.notificationEventPublisher = dependencies.notificationEventPublisher;
    this.auditEventPublisher = dependencies.auditEventPublisher;
    this.hierarchyProjectLinkService = dependencies.hierarchyProjectLinkService;
    this.workflowFilePusher = dependencies.workflowFilePusher;
    this.workflowFragmentRegistry = dependencies.workflowFragmentRegistry;
  }

  get sonar(): SonarCloudSetupService {
    return (this.sonarSetupLazy ??= new SonarCloudSetupService(
      this.githubService,
      this.configService as ConfigService,
    ));
  }

  get workflowFiles(): ProjectWorkflowFilesService {
    return (this.workflowFilesLazy ??= new ProjectWorkflowFilesService(
      this.catalogService,
      this.workflowFragmentRegistry,
    ));
  }

  get tokens(): ProvisioningTokenService {
    return (this.tokensLazy ??= new ProvisioningTokenService(
      this.githubService,
    ));
  }

  get setupBranch(): SetupBranchService {
    return (this.setupBranchLazy ??= new SetupBranchService(
      this.githubService,
    ));
  }

  get workspaceGate(): WorkspaceGateService {
    return (this.workspaceGateLazy ??= new WorkspaceGateService(
      this.projectsRepository,
      this.workspacesService,
    ));
  }

  get productEvents(): ProductEventsService {
    return (this.productEventsLazy ??= new ProductEventsService(
      this.auditEventPublisher ?? this.auditEventsService,
      this.notificationEventPublisher,
    ));
  }

  resolveRepositoryProvisioning(
    userId: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ) {
    return this.tokens.resolveRepositoryProvisioning(userId, accessToken, dto);
  }

  resolveSetupProvisioningToken(
    userId: string,
    oauthAccessToken: string | null | undefined,
    repoFullName: string,
  ) {
    return this.tokens.resolveSetupProvisioningToken(
      userId,
      oauthAccessToken,
      repoFullName,
    );
  }

  resolveWorkspaceIdForCreate(userId: string, workspaceId?: string | null) {
    return this.workspaceGate.resolveWorkspaceIdForCreate(userId, workspaceId);
  }

  resolveSetupBranch(accessToken: string, owner: string, repo: string) {
    return this.setupBranch.resolveSetupBranch(accessToken, owner, repo);
  }

  async pushWorkflowFile(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    commitMessage = 'ci: add ALPHACI workflow',
    branch = 'main',
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    if (this.workflowFilePusher) {
      return this.workflowFilePusher(
        accessToken,
        owner,
        repo,
        filePath,
        content,
        commitMessage,
        branch,
      );
    }

    return this.workflowFiles.pushWorkflowFile(
      accessToken,
      owner,
      repo,
      filePath,
      content,
      commitMessage,
      branch,
    );
  }

  async pushWorkflowFiles(
    accessToken: string,
    owner: string,
    repo: string,
    workflowFiles: StagedWorkflowFile[],
    branch = 'main',
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    let latest: { commitSha: string; commitUrl: string | null } | null = null;

    for (const file of workflowFiles) {
      latest = await this.pushWorkflowFile(
        accessToken,
        owner,
        repo,
        file.path,
        file.yaml,
        undefined,
        branch,
      );
    }

    if (!latest) {
      throw new UnprocessableEntityException(
        'No workflow files were generated',
      );
    }

    return latest;
  }

  buildWorkflowBundle(options: WorkflowBundleOptions) {
    return this.workflowFiles.buildWorkflowBundle(options);
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
  ) {
    return this.workflowFiles.buildWorkflowYaml(
      templateId,
      serviceName,
      servicePath,
      nodeVersion,
      coverageThreshold,
      customOutputFileName,
      enhancements,
    );
  }

  resolveTemplateId(projectTypeId: string, workflowRecipeId?: string): string {
    const { recipes } = this.catalogService.getProjectOptions();
    const recipeId = workflowRecipeId ?? 'standard';
    const recipe = recipes.find((candidate) => candidate.id === recipeId);

    if (recipe) {
      const mapped = recipe.templateByProjectType[projectTypeId];
      if (mapped) return mapped;
    }

    return `${projectTypeId}-${recipeId}`;
  }

  async provisionDeploymentTargets(input: {
    projectId: string;
    userId: string;
    repoFullName: string;
    githubAccessToken: string;
    request: DeploymentProvisioningRequestDto | undefined;
    slots: DeploymentProvisioningTargetDto['slot'][];
  }): Promise<DeploymentProvisioningResult> {
    const request = filterDeploymentProvisioningRequest(
      forceManagedProvisioning(input.request),
      input.slots,
    );
    if (!request?.enabled || request.targets.length === 0) {
      return skippedDeploymentProvisioning();
    }

    try {
      return await this.projectDeploymentProvisioningService.provisionForProject(
        {
          projectId: input.projectId,
          userId: input.userId,
          repoFullName: input.repoFullName,
          githubAccessToken: input.githubAccessToken,
          request,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Deployment provisioning failed for ${input.repoFullName}: ${String(error)}`,
      );
      return {
        status: 'failed',
        targets: request.targets.map((target) => ({
          slot: target.slot,
          provider: target.provider,
          ownershipMode: 'flowci_managed',
          deploymentStrategy: null,
          status: 'failed',
          deploymentTargetId: null,
          providerProjectId: null,
          providerProjectName: null,
          providerMetadata: {},
          errorSummary: 'Deployment provisioning failed',
          env: [],
        })),
      };
    }
  }

  async pushStarterFiles(
    accessToken: string,
    owner: string,
    repo: string,
    opts: {
      projectName: string;
      stack?: string;
      repoShape?: string;
      includeDocker?: boolean;
      frontendStack?: string;
      frontendServiceName?: string;
      backendServiceName?: string;
    },
  ): Promise<void> {
    const {
      projectName,
      stack = 'nodejs',
      repoShape,
      frontendStack,
      frontendServiceName,
      backendServiceName,
    } = opts;

    const scaffoldFiles = buildProjectScaffold({
      serviceName: projectName,
      stack,
      includeDocker: opts.includeDocker ?? defaultIncludeDocker(stack),
      sonarProjectKey: sonarProjectKeyFor(owner, repo),
      ...(repoShape ? { repoShape } : {}),
      ...(frontendStack ? { frontendStack } : {}),
      ...(frontendServiceName ? { frontendServiceName } : {}),
      ...(backendServiceName ? { backendServiceName } : {}),
    });

    for (const file of scaffoldFiles) {
      await this.pushWorkflowFile(
        accessToken,
        owner,
        repo,
        file.path,
        file.content,
        'chore: initialize project scaffold',
      );
    }

    const readmeContent = buildGeneratedRepoReadme({
      projectName,
      stack,
      ...(repoShape ? { repoShape } : {}),
      ...(frontendStack ? { frontendStack } : {}),
      ...(frontendServiceName ? { frontendServiceName } : {}),
      ...(backendServiceName ? { backendServiceName } : {}),
    });

    await this.pushWorkflowFile(
      accessToken,
      owner,
      repo,
      'README.md',
      readmeContent,
      'chore: add project metadata',
    );
  }

  repositoryOwnershipMetadata(
    dto: CreateProjectDto,
    ownerLogin: string,
  ): Record<string, unknown> {
    return {
      repositoryOwner: {
        type: dto.ownerType ?? 'personal',
        login: ownerLogin,
        installationId: dto.installationId ?? null,
      },
    };
  }

  parseRepoFullName(repoFullName: string): [string, string] {
    const parts = repoFullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnprocessableEntityException(
        `Invalid repoFullName '${repoFullName}'. Expected format: "owner/repo"`,
      );
    }

    return [parts[0], parts[1]];
  }

  async createProjectRow(
    input: Parameters<ProjectsRepository['create']>[0],
  ): Promise<Awaited<ReturnType<ProjectsRepository['create']>>> {
    const row = await this.projectsRepository.create(input);

    await this.hierarchyProjectLinkService?.ensureLink({
      projectId: row.id,
      workspaceId: input.workspaceId ?? null,
      name: input.serviceName,
      repoFullName: input.repoFullName,
      visibility: input.visibility ?? null,
      createdBy: input.userId,
      projectStatus: input.status ?? 'provisioning',
    });

    return row;
  }

  async compensateFailedProvision(
    accessToken: string,
    owner: string,
    repo: string,
    projectId: string | undefined,
    userId: string,
  ): Promise<void> {
    if (projectId) {
      try {
        await this.projectsRepository.deleteByIdAndUser(projectId, userId);
      } catch (error) {
        this.logger.warn(
          `Compensation: failed to delete project row ${projectId}: ${String(error)}`,
        );
      }
    }
    await this.githubService.deleteRepo(accessToken, owner, repo);
  }

  async assertWithinQuota(
    userId: string,
    limitCode: string,
    increment: number,
    projectId: string | null,
  ): Promise<void> {
    try {
      await this.usageQuotaService?.assertWithinLimit(
        userId,
        limitCode,
        increment,
      );
    } catch (error) {
      await this.recordProductEvent({
        userId,
        projectId,
        eventCode: 'quota_blocked',
        title: 'Quota blocked action',
        body: `Quota ${limitCode} blocked this action.`,
        metadata: { limitCode, increment },
      });
      throw error;
    }
  }

  recordProductEvent(input: {
    userId: string;
    projectId: string | null;
    eventCode: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    return this.productEvents.record(input);
  }
}
