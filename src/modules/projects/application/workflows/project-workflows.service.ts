import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { QA_BRANCH, WORKING_BRANCH } from '#kernel/config/pipeline-branches';
import {
  releaseSignerFor,
  serverSignsReleases,
} from '#kernel/config/release-signing.config';
import { ConfigService } from '@nestjs/config';
import {
  canCreatePullRequest,
  selfServicePullRequestBase,
} from '#kernel/rules/persona-access.rules';
import { CatalogService } from '../catalog/catalog.service';
import { NotificationEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  USAGE_QUOTA,
  type UsageQuotaPort,
} from '#kernel/ports/usage-quota.port';

type AuditEventSink = Pick<AuditEventPublisher, 'recordProjectEvent'>;
type NotificationEventSink = Pick<NotificationEventPublisher, 'record'>;
import {
  buildStagedWorkflowBundle,
  resolveDefaultCentralWorkflowRef,
  type StagedWorkflowFile,
  type WorkflowFileMetadata,
} from './index';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import {
  DEPLOYMENT_TARGETS_QUERY,
  type DeploymentTargetsQuery,
} from '#kernel/ports/deployment-runtime.port';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../../infrastructure/projects.repository';
import {
  ProjectWorkflowSettingsRepository,
  type ProjectWorkflowSettingsRowValue,
} from '../../infrastructure/project-workflow-settings.repository';
import {
  ProjectWorkflowUpdateRequestsRepository,
  type WorkflowUpdateRequestRecord,
} from '../../infrastructure/project-workflow-update-requests.repository';

export interface WorkflowSettings {
  projectId: string;
  templateId: string;
  projectTypeId: string | null;
  workflowRecipeId: string | null;
  serviceName: string;
  servicePath: string;
  nodeVersion: string;
  packageManager: 'npm';
  coverageThreshold: number;
  centralWorkflowRef: string;
  checks: {
    lint: boolean;
    unit: boolean;
    build: boolean;
    security: boolean;
  };
}

export interface WorkflowSettingsResponse {
  enabled: boolean;
  source: 'stored' | 'project_options';
  settings: WorkflowSettings;
}

export interface WorkflowSettingsPreviewRequest {
  templateId?: string;
  projectTypeId?: string | null;
  workflowRecipeId?: string | null;
  serviceName?: string;
  servicePath?: string;
  nodeVersion?: string;
  packageManager?: 'npm';
  coverageThreshold?: number;
  centralWorkflowRef?: string;
  checks?: Partial<WorkflowSettings['checks']>;
}

export interface WorkflowSettingsPreviewResponse {
  settings: WorkflowSettings;
  workflowFiles: StagedWorkflowFile[];
  diffSummary: Array<{
    path: string;
    status: 'new' | 'changed' | 'unchanged';
  }>;
  validationWarnings: Array<{
    field: string;
    message: string;
  }>;
}

export interface WorkflowUpdatePullRequestResponse {
  projectId: string;
  repoFullName: string;
  branchName: string;
  workflowPath: string;
  workflowFiles: WorkflowFileMetadata[];
  pullRequestNumber: number;
  pullRequestUrl: string;
  status: 'created';
  request: WorkflowUpdateRequestRecord | null;
}

/**
 * Owns workflow settings reads, previews and pull-request orchestration.
 * Extracted from ProjectsService; ProjectsService delegates to this service
 * for these three operations so callers keep their existing entry points.
 */
@Injectable()
export class ProjectWorkflowsService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly catalogService: CatalogService,
    @Optional()
    private readonly workflowSettingsRepository?: ProjectWorkflowSettingsRepository,
    @Optional()
    private readonly workflowUpdateRequestsRepository?: ProjectWorkflowUpdateRequestsRepository,
    @Optional()
    @Inject(USAGE_QUOTA)
    private readonly usageQuotaService?: UsageQuotaPort,
    // Explicit token: AuditEventSink is a type alias, which TypeScript emits
    // as `Object` in design:paramtypes, so without @Inject Nest finds no
    // provider and @Optional() silently injects undefined.
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventSink,
    @Optional()
    @Inject(NotificationEventPublisher)
    private readonly notificationEventsService?: NotificationEventSink,
    @Optional()
    private readonly workflowFragmentRegistry?: WorkflowFragmentRegistry,
    @Optional()
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
    @Optional()
    @Inject(DEPLOYMENT_TARGETS_QUERY)
    private readonly deploymentTargets?: DeploymentTargetsQuery,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async getWorkflowSettings(
    projectId: string,
    userId: string,
  ): Promise<WorkflowSettingsResponse> {
    if (!this.workflowSettingsPreviewEnabled()) {
      throw new BadRequestException('Workflow settings preview is disabled');
    }

    const row = await this.loadOwnedProject(projectId, userId);
    const storedSettings =
      await this.workflowSettingsRepository?.findByProject(projectId);

    if (storedSettings) {
      return {
        enabled: true,
        source: 'stored',
        settings: this.normalizeWorkflowSettings(row, storedSettings),
      };
    }

    return {
      enabled: true,
      source: 'project_options',
      settings: this.normalizeWorkflowSettings(row, null),
    };
  }

  async previewWorkflowSettings(
    projectId: string,
    userId: string,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowSettingsPreviewResponse> {
    if (!this.workflowSettingsPreviewEnabled()) {
      throw new BadRequestException('Workflow settings preview is disabled');
    }

    const row = await this.loadOwnedProject(projectId, userId);
    const storedSettings =
      await this.workflowSettingsRepository?.findByProject(projectId);
    const settings = this.mergeWorkflowSettings(
      this.normalizeWorkflowSettings(row, storedSettings ?? null),
      request,
    );
    const validationWarnings = this.validateWorkflowSettingsPreview(
      settings,
      request,
    );

    if (validationWarnings.length > 0) {
      return {
        settings,
        workflowFiles: [],
        diffSummary: [],
        validationWarnings,
      };
    }

    const { workflowFiles } = await this.buildWorkflowBundle(settings);

    return {
      settings,
      workflowFiles,
      diffSummary: this.buildWorkflowPreviewDiff(
        this.readStoredWorkflowFiles(row),
        workflowFiles,
      ),
      validationWarnings: [],
    };
  }

  async createWorkflowUpdatePullRequest(
    projectId: string,
    userId: string,
    oauthAccessToken: string | null | undefined,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowUpdatePullRequestResponse> {
    if (!this.workflowUpdatePrEnabled()) {
      throw new BadRequestException(
        'Workflow update pull requests are disabled',
      );
    }
    // Visibility first (404), then the persona rule, then quota: a caller
    // who may not open this PR must not spend quota or reach GitHub.
    const row = await this.loadOwnedProject(projectId, userId);
    const role = await this.projectsRepository.findAppRole(userId);
    const branchName = `alphaci/workflow-update-${this.timestampForBranch()}`;
    this.assertMayOpenPullRequest(role, WORKING_BRANCH, branchName);
    await this.assertWithinQuota(userId);
    const token = await this.resolveProvisioningToken(
      userId,
      oauthAccessToken,
      row.repo_full_name,
    );
    const [owner, repo] = this.parseRepoFullName(row.repo_full_name);
    const preview = await this.previewWorkflowSettings(
      projectId,
      userId,
      request,
    );

    if (preview.validationWarnings.length > 0) {
      throw new BadRequestException(
        preview.validationWarnings.map((warning) => warning.message).join(' '),
      );
    }

    // Never the repository default branch (main is production): dev, else
    // uat, else refuse. The role rule is re-applied to the resolved base.
    const baseBranch = await this.resolvePullRequestBase(token, owner, repo);
    this.assertMayOpenPullRequest(role, baseBranch, branchName);
    await this.githubService.createBranch(
      token,
      owner,
      repo,
      branchName,
      baseBranch,
    );

    for (const file of preview.workflowFiles) {
      await this.githubService.putFileContent(
        token,
        owner,
        repo,
        file.path,
        file.yaml,
        branchName,
        'ci: update ALPHACI workflow configuration',
      );
    }

    let pullRequest: { number: number; htmlUrl: string };
    try {
      pullRequest = await this.githubService.createPullRequest(
        token,
        owner,
        repo,
        {
          title: 'Update ALPHACI workflow configuration',
          head: branchName,
          base: baseBranch,
          body: this.buildWorkflowUpdatePullRequestBody(preview),
        },
      );
    } catch (error) {
      throw new BadRequestException(
        'GitHub could not create the workflow update pull request. Check repository permissions and whether an update PR already exists.',
        { cause: error },
      );
    }

    const workflowFiles = preview.workflowFiles.map((file) => ({
      stage: file.stage,
      name: file.name,
      path: file.path,
      gated: file.gated,
    }));
    const persistedRequest =
      (await this.workflowUpdateRequestsRepository?.createRequest({
        projectId,
        requestedBy: userId,
        branchName,
        baseBranch,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.htmlUrl,
        status: 'created',
        settings: preview.settings as unknown as Record<string, unknown>,
        workflowFiles,
      })) ?? null;

    await this.auditEventsService?.recordProjectEvent({
      actorUserId: userId,
      projectId,
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: {
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.htmlUrl,
        branchName,
        baseBranch,
      },
    });

    await this.notificationEventsService?.record({
      userId,
      projectId,
      eventCode: 'workflow_pr_created',
      title: 'Workflow update PR created',
      body: `Workflow update PR #${pullRequest.number} was created for ${row.repo_full_name}.`,
    });

    return {
      projectId,
      repoFullName: row.repo_full_name,
      branchName,
      workflowPath: preview.workflowFiles[0]?.path ?? row.workflow_path,
      workflowFiles,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.htmlUrl,
      status: 'created',
      request: persistedRequest,
    };
  }

  // --- Private helpers moved verbatim from ProjectsService ------------------

  private assertMayOpenPullRequest(
    role: Parameters<typeof canCreatePullRequest>[0],
    base: string,
    head: string,
  ): void {
    // An unresolved role is not in any allow-list, so it is refused. A
    // Developer passes only for base dev (generated head into dev), so a repo
    // with only uat refuses them here, before any branch is created.
    if (!canCreatePullRequest(role, base, head)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PROJECT_ROLE_FORBIDDEN',
        message: 'Your role cannot open workflow pull requests.',
      });
    }
  }

  private async resolvePullRequestBase(
    token: string,
    owner: string,
    repo: string,
  ): Promise<string> {
    const existing: string[] = [];
    for (const candidate of [WORKING_BRANCH, QA_BRANCH]) {
      if (
        await this.githubService.branchExists(token, owner, repo, candidate)
      ) {
        existing.push(candidate);
      }
    }
    const base = selfServicePullRequestBase(existing);
    if (!base) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'PR_BASE_BRANCH_MISSING',
        message:
          "This repository has no 'dev' or 'uat' branch to open the workflow pull request against. Create one first.",
      });
    }
    return base;
  }

  private async loadOwnedProject(
    projectId: string,
    userId: string,
  ): Promise<ProvisionedProjectRow> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }
    return row;
  }

  private readStoredWorkflowFiles(
    row: ProvisionedProjectRow,
  ): WorkflowFileMetadata[] {
    const files = Array.isArray(row.project_options?.['workflowFiles'])
      ? (row.project_options[
          'workflowFiles'
        ] as unknown as WorkflowFileMetadata[])
      : [];
    return files;
  }

  private async buildWorkflowBundle(settings: WorkflowSettings): Promise<{
    workflowFiles: StagedWorkflowFile[];
  }> {
    const template = await this.catalogService.getTemplateById(
      settings.templateId,
    );
    if (!template) {
      throw new NotFoundException(
        `Template '${settings.templateId}' not found`,
      );
    }
    const environments = this.deploymentTargets
      ? await this.projectsRepository.listProjectEnvironments(
          settings.projectId,
        )
      : [];
    // A regenerated environment pipeline keeps the signer identity its sign job needs.
    const releaseSigner =
      environments.length && this.configService
        ? releaseSignerFor((key) => this.configService?.get<string>(key))
        : undefined;
    const targets = this.deploymentTargets
      ? await this.deploymentTargets.listDeploymentTargets(settings.projectId)
      : [];
    const bundle = buildStagedWorkflowBundle(
      template,
      {
        templateId: settings.templateId,
        serviceName: settings.serviceName,
        servicePath: settings.servicePath,
        nodeVersion: settings.nodeVersion,
        coverageThreshold: settings.coverageThreshold,
        centralWorkflowRef: settings.centralWorkflowRef,
        ...(environments.length
          ? {
              environments,
              environmentTargets: targets
                .filter((target) => target.environmentId)
                .map((target) => ({
                  environmentId: target.environmentId!,
                  targetId: target.id,
                  slot: target.slot,
                  provider: target.provider,
                })),
            }
          : {}),
        ...(releaseSigner && { releaseSigner }),
        ...(environments.length > 0 &&
          this.configService &&
          serverSignsReleases((key) =>
            this.configService?.get<string>(key),
          ) && {
            releaseSigning: 'server' as const,
          }),
      },
      this.workflowFragmentRegistry,
    );
    return { workflowFiles: bundle.workflowFiles };
  }

  private async assertWithinQuota(userId: string): Promise<void> {
    await this.usageQuotaService?.assertWithinLimit(userId, 'workflow_prs', 1);
  }

  /**
   * A token for operating on a repository that already exists.
   *
   * The INSTALLATION token comes first here, which is the opposite of
   * `ProvisioningTokenService.resolveProvisioningToken`. That order exists
   * because creating a repository needs a user token — `POST /user/repos` is
   * not available to an installation. Nothing on this path creates anything:
   * it reads the repo, branches, commits files and opens a pull request, all
   * of which an installation can do.
   *
   * Preferring OAuth here made a stale session fatal. A session's OAuth token
   * expires, and this method returned it unconditionally, so the request died
   * on `GitHub repo lookup failed (401): Bad credentials` while a working
   * credential sat unused. An installation token is minted per call and so
   * cannot be stale, which is exactly why it belongs first for existing-repo
   * work. OAuth remains the fallback for a project whose repository is outside
   * the app installation.
   */
  private async resolveProvisioningToken(
    userId: string,
    oauthAccessToken: string | null | undefined,
    repoFullName: string,
  ): Promise<string> {
    const installationToken =
      await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        repoFullName,
      );
    if (installationToken) {
      return installationToken;
    }
    if (oauthAccessToken) {
      return oauthAccessToken;
    }
    throw new UnauthorizedException(
      'No usable GitHub token found. Link the GitHub App installation or re-authenticate via GitHub OAuth.',
    );
  }

  private parseRepoFullName(repoFullName: string): [string, string] {
    const [owner, repo] = repoFullName.split('/');
    return [owner ?? '', repo ?? ''];
  }

  private timestampForBranch(date = new Date()): string {
    return date.toISOString().replaceAll(/\D/g, '').slice(0, 14);
  }

  private buildWorkflowUpdatePullRequestBody(
    preview: WorkflowSettingsPreviewResponse,
  ): string {
    const fileList = preview.workflowFiles
      .map((file) => `- ${file.path}`)
      .join('\n');
    const changedSettings = [
      `Node version: ${preview.settings.nodeVersion}`,
      `Coverage threshold: ${String(preview.settings.coverageThreshold)}`,
      `Service path: ${preview.settings.servicePath}`,
      `Central workflow ref: ${preview.settings.centralWorkflowRef}`,
    ].join('\n');

    return [
      'This PR updates the ALPHACI workflow configuration for this project.',
      '',
      'Changed settings:',
      changedSettings,
      '',
      'Generated workflow files:',
      fileList,
      '',
      'Runtime environment values are not included.',
    ].join('\n');
  }

  private normalizeWorkflowSettings(
    row: ProvisionedProjectRow,
    stored: ProjectWorkflowSettingsRowValue | null,
  ): WorkflowSettings {
    const storedSettings = stored?.settings ?? {};
    const projectOptions = row.project_options ?? {};
    const checks = this.readChecks(projectOptions, storedSettings);

    return {
      projectId: row.id,
      templateId:
        this.readString(storedSettings['templateId']) ?? row.template_id,
      projectTypeId:
        this.readNullableString(storedSettings['projectTypeId']) ??
        row.project_type_id,
      workflowRecipeId:
        this.readNullableString(storedSettings['workflowRecipeId']) ??
        row.workflow_recipe_id,
      serviceName:
        this.readString(storedSettings['serviceName']) ?? row.service_name,
      servicePath:
        this.readString(storedSettings['servicePath']) ??
        this.readString(projectOptions['servicePath']) ??
        '.',
      nodeVersion:
        this.readString(storedSettings['nodeVersion']) ??
        this.readString(projectOptions['nodeVersion']) ??
        '24',
      packageManager: 'npm',
      coverageThreshold:
        this.readNumber(storedSettings['coverageThreshold']) ??
        this.readNumber(projectOptions['coverageThreshold']) ??
        80,
      centralWorkflowRef:
        this.readString(storedSettings['centralWorkflowRef']) ??
        resolveDefaultCentralWorkflowRef(),
      checks,
    };
  }

  private mergeWorkflowSettings(
    base: WorkflowSettings,
    request: WorkflowSettingsPreviewRequest,
  ): WorkflowSettings {
    return {
      ...base,
      ...(request.templateId !== undefined && {
        templateId: request.templateId,
      }),
      ...(request.projectTypeId !== undefined && {
        projectTypeId: request.projectTypeId,
      }),
      ...(request.workflowRecipeId !== undefined && {
        workflowRecipeId: request.workflowRecipeId,
      }),
      ...(request.serviceName !== undefined && {
        serviceName: request.serviceName,
      }),
      ...(request.servicePath !== undefined && {
        servicePath: request.servicePath,
      }),
      ...(request.nodeVersion !== undefined && {
        nodeVersion: request.nodeVersion,
      }),
      packageManager: 'npm',
      ...(request.coverageThreshold !== undefined && {
        coverageThreshold: request.coverageThreshold,
      }),
      ...(request.centralWorkflowRef !== undefined && {
        centralWorkflowRef: request.centralWorkflowRef,
      }),
      checks: {
        ...base.checks,
        ...(request.checks ?? {}),
      },
    };
  }

  private validateWorkflowSettingsPreview(
    settings: WorkflowSettings,
    request: WorkflowSettingsPreviewRequest,
  ): WorkflowSettingsPreviewResponse['validationWarnings'] {
    const warnings: WorkflowSettingsPreviewResponse['validationWarnings'] = [];

    if (
      !Number.isInteger(settings.coverageThreshold) ||
      settings.coverageThreshold < 0 ||
      settings.coverageThreshold > 100
    ) {
      warnings.push({
        field: 'coverageThreshold',
        message: 'Coverage threshold must be between 0 and 100.',
      });
    }

    if (
      request.packageManager !== undefined &&
      request.packageManager !== 'npm'
    ) {
      warnings.push({
        field: 'packageManager',
        message: 'Only npm workflow previews are supported in this phase.',
      });
    }

    if (!/^[0-9]{2}$/.test(settings.nodeVersion)) {
      warnings.push({
        field: 'nodeVersion',
        message: 'Node version must be a two-digit major version.',
      });
    }

    return warnings;
  }

  private buildWorkflowPreviewDiff(
    currentFiles: WorkflowFileMetadata[],
    previewFiles: StagedWorkflowFile[],
  ): WorkflowSettingsPreviewResponse['diffSummary'] {
    const currentPaths = new Set(currentFiles.map((file) => file.path));

    return previewFiles.map((file) => ({
      path: file.path,
      status:
        currentPaths.size === 0
          ? 'new'
          : currentPaths.has(file.path)
            ? 'changed'
            : 'new',
    }));
  }

  private readChecks(
    projectOptions: Record<string, unknown>,
    storedSettings: Record<string, unknown>,
  ): WorkflowSettings['checks'] {
    const storedChecks =
      typeof storedSettings['checks'] === 'object' &&
      storedSettings['checks'] !== null &&
      !Array.isArray(storedSettings['checks'])
        ? (storedSettings['checks'] as Record<string, unknown>)
        : {};
    const optionTests =
      typeof projectOptions['tests'] === 'object' &&
      projectOptions['tests'] !== null &&
      !Array.isArray(projectOptions['tests'])
        ? (projectOptions['tests'] as Record<string, unknown>)
        : {};

    return {
      lint:
        this.readBoolean(storedChecks['lint']) ??
        this.readBoolean(optionTests['lint']) ??
        true,
      unit:
        this.readBoolean(storedChecks['unit']) ??
        this.readBoolean(optionTests['unit']) ??
        true,
      build:
        this.readBoolean(storedChecks['build']) ??
        this.readBoolean(optionTests['build']) ??
        true,
      security:
        this.readBoolean(storedChecks['security']) ??
        this.readBoolean(optionTests['security']) ??
        true,
    };
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private readNullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
  }

  private workflowSettingsPreviewEnabled(): boolean {
    return (
      this.capabilityResolver
        ?.deployment()
        .has('projects.workflow-settings-preview') ?? false
    );
  }

  private workflowUpdatePrEnabled(): boolean {
    return (
      this.capabilityResolver
        ?.deployment()
        .has('projects.workflow-update-pr') ?? false
    );
  }
}
