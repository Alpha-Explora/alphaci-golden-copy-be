import {
  BadRequestException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import { PROTECTED_BRANCHES } from '#kernel/config/pipeline-branches';
import type { CiProjectPort } from '#kernel/ports/ci-project.port';
import type { GithubProjectPort } from '#kernel/ports/github.port';
import { ENV_GUARD_CHECK_CONTEXT } from '#kernel/ports/workflow-generation.port';
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
} from '../../api/dto/create-project.dto';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import type { ProjectEnvironmentInput } from '../../domain/project-environment.policy';
import {
  filterDeploymentProvisioningRequest,
  forceManagedProvisioning,
  skippedDeploymentProvisioning,
} from '../../domain/deployment-provisioning.policy';
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
import type { ProjectRequirementsReadinessPort } from '#kernel/ports/project-requirements-readiness.port';
import { WorkspaceGateService } from './workspace-gate.service';
import { ProductEventsService } from './product-events.service';
import { ProjectWorkflowFilesService } from '../workflows/project-workflow-files.service';
import type {
  DeploymentWorkflowTarget,
  StagedWorkflowFile,
} from '../workflows/index';
import type { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import type {
  StagedEnvironmentTarget,
  StagedWorkflowEnvironment,
} from '../workflows/staged-workflow.builder';

/** One branch's outcome, as recorded in the audit event and the admin report. */
export interface GithubBranchProtectionResult {
  name: string;
  status: 'applied' | 'unchanged' | 'missing' | 'failed';
  error?: string;
}

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
  /** `owner/repo` of the paired frontend/backend repository (multi-repo only). See StagedWorkflowOptions. */
  siblingRepoFullName?: string | undefined;
  environments?: StagedWorkflowEnvironment[] | undefined;
  environmentTargets?: StagedEnvironmentTarget[] | undefined;
}

/**
 * Shared provisioning mechanics for the three project-creation use cases.
 *
 * This is deliberately not a use-case coordinator: it owns only adapters,
 * compensation, event, workflow, and policy helpers that are common to the
 * standalone, microservices-shape, multi-repository, and setup flows. The
 * use-case classes own the ordering and business decisions.
 */
export interface NewProjectLinkOptions {
  /** Link into this existing delivery project instead of creating a new chain. */
  deliveryProjectId?: string;
  /** Name for a newly auto-created system/delivery-project chain. */
  chainName?: string;
  /** `chainName` is a caller-chosen Project name that must be unique in the team. */
  enforceUniqueChainName?: boolean;
  /**
   * 'new-repository' ONLY where ALPHACI just created the GitHub repository.
   * Omitted (Setup, which attaches an existing repository) means no automatic
   * GitHub grants at all.
   */
  accessGrant?: 'new-repository' | 'none';
}

/**
 * Link options for the row that creates a NEW hierarchy chain. A
 * caller-chosen `projectName` names the chain and is uniqueness-enforced;
 * without it the legacy name (`legacyChainName`, or the service name when
 * omitted) applies unchecked. An explicit deliveryProjectId wins over both.
 */
export function newChainLinkOptions(
  dto: { projectName?: string; deliveryProjectId?: string },
  legacyChainName?: string,
): NewProjectLinkOptions {
  if (dto.deliveryProjectId) {
    return { deliveryProjectId: dto.deliveryProjectId };
  }
  const projectName = dto.projectName?.trim();
  if (projectName) {
    return { chainName: projectName, enforceUniqueChainName: true };
  }
  return legacyChainName !== undefined ? { chainName: legacyChainName } : {};
}

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
  readonly requirementsReadiness: ProjectRequirementsReadinessPort | undefined;

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
    requirementsReadiness: ProjectRequirementsReadinessPort | undefined;
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
    this.requirementsReadiness = dependencies.requirementsReadiness;
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
      this.configService,
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
      this.requirementsReadiness,
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

  resolveWorkspaceIdForCreate(
    userId: string,
    workspaceId?: string | null,
    deliveryProjectId?: string | null,
    options?: { requireFeatures?: boolean },
  ) {
    return this.workspaceGate.resolveWorkspaceIdForCreate(
      userId,
      workspaceId,
      deliveryProjectId,
      options,
    );
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

    // Through the GitHub port, like every other repository write, so the
    // push uses its retrying client and can be replaced at the port.
    return this.githubService.putFileContent(
      accessToken,
      owner,
      repo,
      filePath,
      content,
      branch,
      commitMessage,
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
      forceManagedProvisioning(
        input.request,
        (provider) =>
          this.workflowFragmentRegistry?.deliveredByHost(provider) ?? false,
      ),
      input.slots,
    );
    if (!request?.enabled || request.targets.length === 0) {
      return skippedDeploymentProvisioning();
    }

    try {
      const result =
        await this.projectDeploymentProvisioningService.provisionForProject({
          projectId: input.projectId,
          userId: input.userId,
          repoFullName: input.repoFullName,
          githubAccessToken: input.githubAccessToken,
          request,
        });
      this.warnAboutDeployJobsWithNoTarget(input.repoFullName, result);
      return result;
    } catch (error) {
      this.logger.warn(
        `Deployment provisioning failed for ${input.repoFullName}: ${String(error)}`,
      );
      const failed: DeploymentProvisioningResult = {
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
      // The throwing path strands deploy jobs exactly as the returning one
      // does, so it says the same thing.
      this.warnAboutDeployJobsWithNoTarget(input.repoFullName, failed);
      return failed;
    }
  }

  /**
   * Says out loud when a pipeline was generated for infrastructure that does
   * not exist.
   *
   * The workflow files and the provider resources come from the same request
   * but are produced by two different steps, and only the first one is
   * required to succeed for the project to be reported as `provisioned`. So a
   * provider whose creation failed leaves a repository carrying deploy jobs
   * with nothing behind them - which is exactly what happened to a React
   * project: three Vercel deploy jobs committed, zero deployment targets
   * stored, and a green "project created".
   *
   * The failure is then discovered much later, in another repository, in
   * another workflow, as a credential error that names none of this. Naming it
   * here - where both halves are visible in the same place - is the difference
   * between a five-minute fix and an afternoon.
   *
   * This does not throw. The repository and its pipeline are real and useful
   * without a deployment, and failing project creation over it would destroy
   * more than it protects.
   */
  private warnAboutDeployJobsWithNoTarget(
    repoFullName: string,
    result: DeploymentProvisioningResult,
  ): void {
    const stranded = result.targets.filter(
      (target) => target.status !== 'created' && target.status !== 'registered',
    );

    if (stranded.length === 0) {
      return;
    }

    const described = stranded
      .map(
        (target) =>
          `${target.provider}/${target.slot}` +
          (target.errorSummary ? ` (${target.errorSummary})` : ''),
      )
      .join(', ');

    this.logger.warn(
      `Deployment provisioning did not complete for ${described} on ${repoFullName}. ` +
        `The pipeline generated for this repository still contains deploy jobs for ` +
        `those targets, and they will run with nothing to deploy to. Either provision ` +
        `them and add the deployment secrets, or regenerate the workflows without them.`,
    );
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

    // Declared per stack in the catalog. Absent for the Node stacks, which take
    // their version from the generate DTO instead.
    const runtimeVersion = this.catalogService.getStackRuntimeVersion(stack);

    const scaffoldFiles = buildProjectScaffold({
      serviceName: projectName,
      stack,
      includeDocker: opts.includeDocker ?? defaultIncludeDocker(stack),
      sonarProjectKey: sonarProjectKeyFor(owner, repo),
      ...(runtimeVersion ? { runtimeVersion } : {}),
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
    input: Parameters<ProjectsRepository['create']>[0] & {
      environments?: ProjectEnvironmentInput[];
    },
    linkOptions?: NewProjectLinkOptions,
  ): Promise<{
    row: Awaited<ReturnType<ProjectsRepository['create']>>;
    deliveryProjectId: string | null;
  }> {
    const { environments, ...projectInput } = input;
    const row = await this.projectsRepository.create(projectInput);

    if (environments) {
      try {
        await this.projectsRepository.createProjectEnvironments(
          row.id,
          environments,
        );
      } catch (error) {
        try {
          const deleted = await this.projectsRepository.deleteByIdAndUser(
            row.id,
            row.user_id,
          );
          if (!deleted) {
            this.logger.warn(
              `Compensation: failed to delete project row ${row.id} after environment insert failure`,
            );
          }
        } catch (cleanupError) {
          this.logger.warn(
            `Compensation: failed to delete project row ${row.id} after environment insert failure: ${String(cleanupError)}`,
          );
        }
        throw error;
      }
    }

    let link: Awaited<ReturnType<ProjectLinkPort['ensureLink']>> | undefined;
    try {
      link = await this.hierarchyProjectLinkService?.ensureLink({
        projectId: row.id,
        workspaceId: input.workspaceId ?? null,
        name: input.serviceName,
        repoFullName: input.repoFullName,
        visibility: input.visibility ?? null,
        createdBy: input.userId,
        projectStatus: input.status ?? 'provisioning',
        ...(linkOptions?.chainName !== undefined && {
          chainName: linkOptions.chainName,
        }),
        ...(linkOptions?.enforceUniqueChainName && {
          enforceUniqueChainName: true,
        }),
        ...(linkOptions?.deliveryProjectId !== undefined && {
          deliveryProjectId: linkOptions.deliveryProjectId,
        }),
        accessGrant: linkOptions?.accessGrant ?? 'none',
      });
    } catch (error) {
      // Lost the Project-name race after the repo may already exist: drop the
      // row we just wrote so the caller's compensation (which removes the
      // GitHub repo on create paths) leaves nothing half-created, then fail.
      await this.projectsRepository
        .deleteByIdAndUser(row.id, input.userId)
        .catch((deleteError: unknown) => {
          this.logger.warn(
            `Could not remove project row ${row.id} after a failed link: ${String(deleteError)}`,
          );
        });
      throw error;
    }

    return { row, deliveryProjectId: link?.deliveryProjectId ?? null };
  }

  /**
   * Up-front gate for a caller-chosen Project name. Must run BEFORE any
   * GitHub call. No-op when no name was given, an existing Project is being
   * joined, or no hierarchy is wired up; personal workspaces are skipped by
   * the hierarchy service (they have no Projects).
   */
  async assertProjectNameAvailableForCreate(input: {
    projectName: string | undefined;
    deliveryProjectId: string | undefined;
    workspaceId: string | null;
  }): Promise<void> {
    const name = input.projectName?.trim();
    if (!name || input.deliveryProjectId || !input.workspaceId) return;
    await this.hierarchyProjectLinkService?.assertProjectNameAvailableForCreate(
      {
        workspaceId: input.workspaceId,
        name,
      },
    );
  }

  /**
   * Up-front gate for a caller-supplied `deliveryProjectId` on project
   * creation. Must be called BEFORE any GitHub call — a late rejection would
   * strand a real repository. Fails closed: an unresolvable workspace, or a
   * deployment with no hierarchy port wired up, cannot vouch for the id, so
   * the id is rejected rather than silently accepted.
   */
  async assertDeliveryProjectAvailableForCreate(input: {
    deliveryProjectId: string;
    workspaceId: string | null;
    userId: string;
  }): Promise<void> {
    if (!input.workspaceId) {
      throw new BadRequestException(
        'deliveryProjectId requires the project to belong to a team workspace.',
      );
    }
    if (!this.hierarchyProjectLinkService) {
      throw new UnprocessableEntityException(
        'Project hierarchy is not available; deliveryProjectId cannot be validated.',
      );
    }
    await this.hierarchyProjectLinkService.assertDeliveryProjectAvailableForCreate(
      {
        deliveryProjectId: input.deliveryProjectId,
        workspaceId: input.workspaceId,
        userId: input.userId,
      },
    );
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

  /**
   * Announces a created project (spec section 7): the creator, every active
   * workspace lead and every active workspace developer get ONE notification
   * each, deduplicated. This replaces the old creator-only notification, so
   * nobody gets two; the single audit row is unchanged.
   *
   * Never throws into provisioning: failures are logged and swallowed.
   */
  async notifyProjectCreated(input: {
    workspaceId: string | null;
    creatorUserId: string;
    creatorLogin: string;
    projectId: string;
    repoFullName: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await (
        this.auditEventPublisher ?? this.auditEventsService
      )?.recordProjectEvent({
        actorUserId: input.creatorUserId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        eventCode: 'project_created',
        message: 'Project created',
        metadata: { repoFullName: input.repoFullName, ...input.metadata },
      });

      const notifications = this.notificationEventPublisher;
      if (!notifications) {
        return;
      }

      const teamIds = input.workspaceId
        ? await this.projectsRepository.listWorkspaceLeadAndDeveloperIds(
            input.workspaceId,
          )
        : [];
      const recipients = [...new Set([...teamIds, input.creatorUserId])];

      await Promise.all(
        recipients.map((userId) =>
          notifications.record({
            userId,
            projectId: input.projectId,
            eventCode: 'project_created',
            title: `New project created: ${input.repoFullName}`,
            body: `@${input.creatorLogin} created project ${input.repoFullName}. It is now tracked and ready for development.`,
          }),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `project_created announcement failed for ${input.repoFullName}: ${String(error)}`,
      );
    }
  }

  /**
   * Requires a pull request on dev, uat and main of a repository provisioning
   * just filled (the initial "ci: add ALPHACI workflow" commits are already
   * pushed, which is why this runs last). Best effort by design: a repository
   * that provisioned fine must not be torn down because GitHub refused the
   * rule, so a failure logs a warning and records
   * `project_branch_protection_failed`; success records
   * `project_branch_protection_applied`. Never throws.
   */
  async protectPipelineBranches(input: {
    token: string;
    owner: string;
    repo: string;
    userId: string;
    projectId: string;
    workspaceId?: string | null;
    branches?: readonly string[];
  }): Promise<void> {
    const repoFullName = `${input.owner}/${input.repo}`;
    const branches: GithubBranchProtectionResult[] = [];
    for (const name of input.branches ?? PROTECTED_BRANCHES) {
      try {
        const outcome = await this.githubService.ensurePullRequestProtection(
          input.token,
          input.owner,
          input.repo,
          name,
          { seedStatusChecks: [ENV_GUARD_CHECK_CONTEXT] },
        );
        branches.push({ name, ...outcome });
      } catch (error) {
        branches.push({
          name,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const failed = branches.filter((branch) => branch.status === 'failed');
    if (failed.length > 0) {
      this.logger.warn(
        `Branch protection failed on ${repoFullName}: ${failed
          .map((branch) => `${branch.name} (${branch.error ?? 'unknown'})`)
          .join('; ')}`,
      );
    }
    try {
      await (
        this.auditEventPublisher ?? this.auditEventsService
      )?.recordProjectEvent({
        actorUserId: input.userId,
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId,
        eventCode:
          failed.length > 0
            ? 'project_branch_protection_failed'
            : 'project_branch_protection_applied',
        message:
          failed.length > 0
            ? `Branch protection could not be applied to ${failed
                .map((branch) => branch.name)
                .join(', ')}`
            : `Pull requests are now required on ${(input.branches ?? PROTECTED_BRANCHES).join(', ')}`,
        metadata: { repoFullName, branches },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record the branch protection event for ${repoFullName}: ${String(error)}`,
      );
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
