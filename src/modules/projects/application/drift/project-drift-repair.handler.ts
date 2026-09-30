import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  CI_PROJECT_PORT,
  type CiProjectPort,
} from '#kernel/ports/ci-project.port';
import {
  DEPLOYMENT_DRIFT_FINDINGS_STORE,
  DEPLOYMENT_TARGET_DELETION,
  type DeploymentDriftFindingsStore,
  type DeploymentTargetDeletion,
  type ProjectDriftFinding,
  type ProjectDriftRepairAction,
  type ProjectDriftRepairResponse,
} from '#kernel/ports/deployment-runtime.port';
import { NotificationEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  PROTECTED_BRANCHES,
  WORKING_BRANCH,
} from '#kernel/config/pipeline-branches';
import {
  canCreatePullRequest,
  canManageProjectLifecycle,
} from '#kernel/rules/persona-access.rules';
import { canRepairBranchProtection } from '../../domain/drift-repair-access.rules';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectWorkflowsService } from '../workflows/project-workflows.service';

type DriftRepairContext = {
  projectId: string;
  findingId: string;
  userId: string;
  action: ProjectDriftRepairAction;
  githubAccessToken: string | null;
  finding: ProjectDriftFinding;
};

@Injectable()
export class ProjectDriftRepairService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(DEPLOYMENT_DRIFT_FINDINGS_STORE)
    private readonly findingsRepository: DeploymentDriftFindingsStore,
    @Inject(CI_PROJECT_PORT)
    private readonly ciService: CiProjectPort,
    @Optional()
    @Inject(DEPLOYMENT_TARGET_DELETION)
    private readonly deploymentTargetsRepository?: DeploymentTargetDeletion,
    @Optional()
    private readonly projectWorkflowsService?: ProjectWorkflowsService,
    @Optional()
    private readonly auditEventsService?: AuditEventPublisher,
    @Optional()
    private readonly notificationEventsService?: NotificationEventPublisher,
    @Optional()
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
    @Optional()
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService?: GithubProjectPort,
  ) {}

  async repair(
    projectId: string,
    findingId: string,
    userId: string,
    action: ProjectDriftRepairAction,
    githubAccessToken: string | null,
  ): Promise<ProjectDriftRepairResponse> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (!this.enabled()) {
      return this.disabled(findingId, action, 'Drift repair is disabled');
    }

    const finding = await this.findingsRepository.findByIdForProject(
      projectId,
      findingId,
    );
    if (!finding) {
      throw new NotFoundException('Drift finding not found');
    }
    if (finding.status !== 'active') {
      throw new BadRequestException('Drift finding is not active');
    }

    if (this.requiresLiveProvider(finding)) {
      return this.disabled(
        findingId,
        action,
        'Live provider activation required',
      );
    }

    const ctx: DriftRepairContext = {
      projectId,
      findingId,
      userId,
      action,
      githubAccessToken,
      finding,
    };

    // Visibility (404) came first above; the persona gate runs before any
    // action-specific work. Every action is allow-listed on the global
    // app_role: an unlisted or unresolved role is refused (fail closed).
    switch (action) {
      case 'mark_ignored':
        await this.assertLifecycleRole(ctx);
        return this.markIgnored(ctx);
      case 'rotate_ci_token':
        await this.assertLifecycleRole(ctx);
        return this.rotateCiToken(ctx);
      case 'detach_target':
        await this.assertLifecycleRole(ctx);
        return this.detachTarget(ctx);
      case 'repair_branch_protection':
        return this.repairBranchProtection(ctx, project.repo_full_name);
      case 'regenerate_workflow_preview':
        await this.assertPullRequestRole(ctx);
        return this.regenerateWorkflowPreview(ctx);
      case 'create_workflow_update_pr':
        await this.assertPullRequestRole(ctx);
        return this.createWorkflowUpdatePr(ctx);
      default:
        throw new BadRequestException('Unsupported repair action');
    }
  }

  /** admin | lead only (canManageProjectLifecycle); 403 PROJECT_ROLE_FORBIDDEN. */
  private async assertLifecycleRole(ctx: DriftRepairContext): Promise<void> {
    const role = await this.projectsRepository.findAppRole(ctx.userId);
    if (!canManageProjectLifecycle(role)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PROJECT_ROLE_FORBIDDEN',
        message: 'Only a lead or admin may apply this drift repair.',
      });
    }
  }

  /**
   * Workflow preview / update PR: the PR base is the working tier (dev), never
   * main, so the rule is canCreatePullRequest(role, dev) -- qa is refused. The
   * workflows service re-applies the same rule to the base it actually
   * resolves (dev, else uat).
   */
  private async assertPullRequestRole(ctx: DriftRepairContext): Promise<void> {
    const role = await this.projectsRepository.findAppRole(ctx.userId);
    if (!canCreatePullRequest(role, WORKING_BRANCH)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PROJECT_ROLE_FORBIDDEN',
        message: 'Your role cannot open workflow pull requests.',
      });
    }
  }

  private async markIgnored(
    ctx: DriftRepairContext,
  ): Promise<ProjectDriftRepairResponse> {
    await this.findingsRepository.markStatus(ctx.findingId, 'ignored');
    await this.recordRepairEvent({
      userId: ctx.userId,
      projectId: ctx.projectId,
      eventCode: 'drift_repair_completed',
      title: 'Drift finding ignored',
      body: ctx.finding.message,
      metadata: {
        findingId: ctx.findingId,
        action: ctx.action,
        findingCode: ctx.finding.code,
      },
    });
    return this.completed(ctx.findingId, ctx.action, 'Finding marked ignored');
  }

  /**
   * Re-applies protection to one uat/main branch. Only ever runs on explicit
   * request, and only for lead/admin (allow-list on the global app_role).
   * It cannot un-protect `dev`, so branch_dev_protected is not repairable.
   */
  private async repairBranchProtection(
    ctx: DriftRepairContext,
    repoFullName: string,
  ): Promise<ProjectDriftRepairResponse> {
    const role = await this.projectsRepository.findAppRole(ctx.userId);
    if (!canRepairBranchProtection(role)) {
      throw new ForbiddenException(
        'Only a team lead or admin can repair branch protection',
      );
    }
    this.assertCode(
      ctx.finding,
      [
        'branch_protection_missing',
        'branch_force_push_allowed',
        'branch_deletion_allowed',
      ],
      ctx.action,
    );
    const branch = ctx.finding.details['branch'];
    const protectedBranches: readonly string[] = PROTECTED_BRANCHES;
    if (typeof branch !== 'string' || !protectedBranches.includes(branch)) {
      throw new BadRequestException('Finding does not name a protected branch');
    }
    const [owner, repo] = repoFullName.split('/');
    if (!ctx.githubAccessToken || !this.githubService || !owner || !repo) {
      throw new BadRequestException(
        'A GitHub session is required to repair branch protection',
      );
    }
    await this.githubService.applyBranchProtection(
      ctx.githubAccessToken,
      owner,
      repo,
      branch,
    );
    await this.findingsRepository.markStatus(ctx.findingId, 'resolved');
    await this.recordRepairEvent({
      userId: ctx.userId,
      projectId: ctx.projectId,
      eventCode: 'drift_repair_completed',
      title: 'Branch protection re-applied',
      body: `Protection was re-applied to ${branch}.`,
      metadata: {
        findingId: ctx.findingId,
        action: ctx.action,
        findingCode: ctx.finding.code,
        branch,
      },
    });
    return this.completed(
      ctx.findingId,
      ctx.action,
      'Branch protection re-applied',
      { branch },
    );
  }

  private async rotateCiToken(
    ctx: DriftRepairContext,
  ): Promise<ProjectDriftRepairResponse> {
    this.assertCode(
      ctx.finding,
      ['ci_token_missing', 'ci_token_revoked'],
      ctx.action,
    );
    const result = await this.ciService.issueProjectToken(ctx.projectId);
    await this.findingsRepository.markStatus(ctx.findingId, 'resolved');
    await this.recordRepairEvent({
      userId: ctx.userId,
      projectId: ctx.projectId,
      eventCode: 'ci_token_rotated',
      title: 'CI token rotated',
      body: 'A project CI token was rotated in ALPHACI.',
      metadata: {
        findingId: ctx.findingId,
        action: ctx.action,
        findingCode: ctx.finding.code,
        tokenPrefix: result.tokenPrefix,
      },
    });
    return this.completed(
      ctx.findingId,
      ctx.action,
      'CI token rotated in ALPHACI',
      {
        tokenPrefix: result.tokenPrefix,
      },
    );
  }

  private async detachTarget(
    ctx: DriftRepairContext,
  ): Promise<ProjectDriftRepairResponse> {
    this.assertCode(
      ctx.finding,
      ['deployment_target_metadata_missing', 'provider_target_missing_live'],
      ctx.action,
    );
    if (!ctx.finding.targetId) {
      throw new BadRequestException('Finding is not associated with a target');
    }
    const detached =
      await this.deploymentTargetsRepository?.deleteDeploymentTargetForUser(
        ctx.projectId,
        ctx.finding.targetId,
        ctx.userId,
      );
    if (!detached) {
      throw new NotFoundException('Deployment target not found');
    }
    await this.findingsRepository.markStatus(ctx.findingId, 'resolved');
    await this.recordRepairEvent({
      userId: ctx.userId,
      projectId: ctx.projectId,
      eventCode: 'drift_repair_completed',
      title: 'Drift repair completed',
      body: 'Deployment target detached from ALPHACI.',
      metadata: {
        findingId: ctx.findingId,
        action: ctx.action,
        findingCode: ctx.finding.code,
        targetId: ctx.finding.targetId,
      },
    });
    return this.completed(
      ctx.findingId,
      ctx.action,
      'Deployment target detached from ALPHACI',
      { targetId: ctx.finding.targetId },
    );
  }

  private async regenerateWorkflowPreview(
    ctx: DriftRepairContext,
  ): Promise<ProjectDriftRepairResponse> {
    this.assertCode(
      ctx.finding,
      ['workflow_files_missing', 'central_workflow_ref_outdated'],
      ctx.action,
    );
    const preview = await this.projectWorkflowsService?.previewWorkflowSettings(
      ctx.projectId,
      ctx.userId,
      {},
    );
    await this.recordRepairEvent({
      userId: ctx.userId,
      projectId: ctx.projectId,
      eventCode: 'drift_repair_completed',
      title: 'Drift repair completed',
      body: 'Workflow preview regenerated.',
      metadata: {
        findingId: ctx.findingId,
        action: ctx.action,
        findingCode: ctx.finding.code,
      },
    });
    return this.completed(
      ctx.findingId,
      ctx.action,
      'Workflow preview regenerated',
      {
        workflowFiles: preview?.workflowFiles ?? [],
        validationWarnings: preview?.validationWarnings ?? [],
      },
    );
  }

  private async createWorkflowUpdatePr(
    ctx: DriftRepairContext,
  ): Promise<ProjectDriftRepairResponse> {
    this.assertCode(
      ctx.finding,
      ['workflow_files_missing', 'central_workflow_ref_outdated'],
      ctx.action,
    );
    if (!this.workflowUpdatePrEnabled()) {
      return this.disabled(
        ctx.findingId,
        ctx.action,
        'Workflow update PR creation is disabled',
      );
    }
    const pullRequest =
      await this.projectWorkflowsService?.createWorkflowUpdatePullRequest(
        ctx.projectId,
        ctx.userId,
        ctx.githubAccessToken,
        {},
      );
    await this.findingsRepository.markStatus(ctx.findingId, 'resolved');
    await this.recordRepairEvent({
      userId: ctx.userId,
      projectId: ctx.projectId,
      eventCode: 'drift_repair_completed',
      title: 'Drift repair completed',
      body: 'Workflow update PR created from a drift finding.',
      metadata: {
        findingId: ctx.findingId,
        action: ctx.action,
        findingCode: ctx.finding.code,
        pullRequestNumber: pullRequest?.pullRequestNumber ?? null,
        pullRequestUrl: pullRequest?.pullRequestUrl ?? null,
      },
    });
    return this.completed(
      ctx.findingId,
      ctx.action,
      'Workflow update PR created',
      {
        pullRequestUrl: pullRequest?.pullRequestUrl ?? null,
        pullRequestNumber: pullRequest?.pullRequestNumber ?? null,
      },
    );
  }

  private enabled(): boolean {
    return (
      this.capabilityResolver?.deployment().has('runtime.drift-repair') ?? false
    );
  }

  private workflowUpdatePrEnabled(): boolean {
    return (
      this.capabilityResolver
        ?.deployment()
        .has('projects.workflow-update-pr') ?? false
    );
  }

  private requiresLiveProvider(finding: ProjectDriftFinding): boolean {
    return [
      'github_repo_unreachable',
      'github_secret_missing',
      'provider_env_key_missing_live',
      'provider_target_missing_live',
    ].includes(finding.code);
  }

  private assertCode(
    finding: ProjectDriftFinding,
    supportedCodes: string[],
    action: ProjectDriftRepairAction,
  ) {
    if (!supportedCodes.includes(finding.code)) {
      throw new BadRequestException(
        `Repair action ${action} does not support finding ${finding.code}`,
      );
    }
  }

  private async recordRepairEvent(input: {
    userId: string;
    projectId: string;
    eventCode: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      actorUserId: input.userId,
      projectId: input.projectId,
      eventCode: input.eventCode,
      message: input.title,
      metadata: input.metadata,
    });
    await this.notificationEventsService?.record({
      userId: input.userId,
      projectId: input.projectId,
      eventCode: input.eventCode,
      title: input.title,
      body: input.body,
    });
  }

  private completed(
    findingId: string,
    action: ProjectDriftRepairAction,
    message: string,
    result?: Record<string, unknown>,
  ): ProjectDriftRepairResponse {
    return {
      enabled: true,
      mode: 'local_safe',
      findingId,
      action,
      status: 'completed',
      message,
      ...(result ? { result } : {}),
    };
  }

  private disabled(
    findingId: string,
    action: ProjectDriftRepairAction,
    message: string,
  ): ProjectDriftRepairResponse {
    return {
      enabled: false,
      mode: 'local_safe',
      findingId,
      action,
      status: 'disabled',
      message,
    };
  }
}
