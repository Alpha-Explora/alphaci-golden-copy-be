import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import { NotificationEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  USAGE_QUOTA,
  type UsageQuotaPort,
} from '#kernel/ports/usage-quota.port';
import { DeploymentTargetsRepository } from '../infrastructure/repositories/deployment-targets.repository';
import type { UpdateDeploymentTargetMetadataInput } from '../core/deployments.types';
import {
  assertProviderSlotAllowed,
  DeploymentPolicyViolation,
} from '../domain/deployment-target.policy';
import { DeploymentStrategyResolver } from '../domain/deployment-strategy.resolver';
import type { CreateDeploymentTargetDto } from '../api/dto/create-deployment-target.dto';
import type { DetachDeploymentTargetDto } from '../api/dto/detach-deployment-target.dto';
import {
  buildCreateTargetPersistInput,
  buildCreateTargetTokenInput,
  buildProviderTargetRequest,
  mapSlotViolation,
} from './create-deployment-target.steps';
import { EnvTokenEncryptionService } from './encryption.service';
import {
  PROVIDER_CLIENT_REGISTRY,
  type ProviderClientRegistryPort,
} from './ports/provider-client-registry.port';
import type {
  DeploymentTargetSummary,
  EnvProvider,
  EnvTargetSlot,
  RenderEnvironmentName,
} from '../core/deployments.types';
import { ProviderConnectionsRepository } from '../infrastructure/repositories/provider-connections.repository';
import {
  WORKSPACE_ACCESS_PORT,
  type WorkspaceAccessPort,
  type WorkspaceRole,
} from '#kernel/ports/workspaces.port';
import {
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  type DeploymentProjectReference,
  type DeploymentProjectReferenceLookup,
  type DeploymentProviderResourcesTeardown,
  type ProviderResourcesTeardownResult,
} from '../core/deployment-provisioning.contract';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import type { DeploymentProvider } from '../core/deployment-provider.contract';
import type {
  DeploymentProviderLogEntry,
  DeploymentProviderPolicy,
  DeploymentProviderTargetPolicyResult,
} from '../domain/deployment-provider.policy';

export type DeploymentTargetLogEntry = DeploymentProviderLogEntry;

const EMPTY_PROVIDER_TARGET_POLICY: DeploymentProviderTargetPolicyResult = {
  storage: {},
  providerInput: {},
  providerMetadata: {},
} as const;

@Injectable()
export class DeploymentTargetsService implements DeploymentProviderResourcesTeardown {
  private readonly logger = new Logger(DeploymentTargetsService.name);

  constructor(
    @Inject(DEPLOYMENT_PROJECT_REFERENCE_LOOKUP)
    private readonly projectReferenceLookup: DeploymentProjectReferenceLookup,
    private readonly deploymentTargetsRepository: DeploymentTargetsRepository,
    private readonly providerConnectionsRepository: ProviderConnectionsRepository,
    private readonly encryptionService: EnvTokenEncryptionService,
    @Inject(PROVIDER_CLIENT_REGISTRY)
    private readonly clientRegistry: ProviderClientRegistryPort,
    private readonly configService: ConfigService,
    private readonly deploymentStrategyResolver: DeploymentStrategyResolver,
    /** Retained in the constructor order for direct callers during the seam migration. */
    @Optional()
    @Inject('LegacyDeploymentTargetDefaults')
    _legacyTargetDefaults?: unknown,
    @Optional()
    @Inject(USAGE_QUOTA)
    private readonly usageQuotaService?: UsageQuotaPort,
    @Optional()
    @Inject(WORKSPACE_ACCESS_PORT)
    private readonly workspaceAccessService?: WorkspaceAccessPort,
    @Optional()
    private readonly auditEventsService?: AuditEventPublisher,
    @Optional()
    private readonly notificationEventsService?: NotificationEventPublisher,
    @Optional()
    private readonly providerRegistry?: DeploymentProviderRegistry<DeploymentProvider>,
  ) {}

  async listDeploymentTargets(projectId: string, userId: string) {
    await this.getProjectOrThrow(projectId, userId);
    const targets =
      await this.deploymentTargetsRepository.listDeploymentTargets(projectId);

    // Enrich with copyable links: the live service URL and the provider
    // dashboard, so the UI never has to re-derive provider URL conventions.
    return targets.map((target) => ({
      ...target,
      publicUrl: this.providerPublicUrl(target),
      dashboardUrl: this.providerDashboardUrl(target),
    }));
  }

  async createDeploymentTarget(
    projectId: string,
    userId: string,
    dto: CreateDeploymentTargetDto,
  ) {
    await this.assertProjectMutationAccess(projectId, userId);
    const project = await this.getProjectOrThrow(projectId, userId);
    await this.assertWithinQuota(userId, projectId, 'deployment_targets');
    this.assertOwnershipModeAllowed(dto);
    try {
      assertProviderSlotAllowed(
        dto.provider,
        dto.slot,
        this.providerRegistry?.find(dto.provider),
      );
    } catch (error) {
      mapSlotViolation(error);
    }
    const providerPolicy = this.providerPolicy(dto.provider);
    if (
      dto.ownershipMode === 'flowci_managed' &&
      providerPolicy?.managedQuota
    ) {
      await this.assertWithinQuota(
        userId,
        projectId,
        providerPolicy.managedQuota.quotaCode,
      );
    }
    // Platform-wide capacity guard: managed targets share provider accounts, so
    // cap the aggregate across all users. The provider id is data here; quota
    // policy stays inside the provider plugin.
    if (
      dto.ownershipMode === 'flowci_managed' &&
      providerPolicy?.managedQuota
    ) {
      await this.usageQuotaService?.assertManagedFleetCapacity({
        providerId: dto.provider,
        ...providerPolicy.managedQuota,
      });
    }
    const providerAuth = await this.resolveProviderToken(
      dto.provider,
      userId,
      buildCreateTargetTokenInput(dto),
    );
    const deploymentStrategy = this.deploymentStrategyResolver.resolve({
      provider: dto.provider,
      ownershipMode: dto.ownershipMode,
      action: dto.action,
      renderDeployMethod: dto.renderDeployMethod,
    });
    /*
     * A provider with a policy never answers `provider_native`; the resolver
     * only falls back to it when the policy was not reached. That fallback
     * used to be accepted, and it cost every managed target its pipeline
     * secrets: the installers act only on the provider's own strategies, so
     * all 13 Render and Vercel targets were created, reported as provisioned,
     * and left with deploy jobs reading secrets nothing ever wrote.
     *
     * Checked here, before anything is created at the provider, so a wiring
     * fault stops the target outright instead of leaving a live service with
     * no way to deploy to it.
     */
    if (providerPolicy && deploymentStrategy === 'provider_native') {
      throw new InternalServerErrorException(
        `The deployment strategy for ${dto.provider} could not be resolved, so no target was created. This is a server configuration fault, not a problem with the project.`,
      );
    }
    const providerTargetPolicy =
      providerPolicy?.resolveTarget(
        buildProviderTargetRequest({
          dto,
          connectionMetadata: providerAuth.connectionMetadata,
          managedConfig: this.managedProviderConfig(),
        }),
      ) ?? EMPTY_PROVIDER_TARGET_POLICY;

    const target =
      dto.action === 'create'
        ? await this.clientRegistry.getClient(dto.provider).createTarget({
            token: providerAuth.token,
            repoFullName: project.repoFullName,
            projectName: this.requireString(dto.projectName, 'projectName'),
            branchName: dto.branchName?.trim() || 'uat',
            ...(dto.rootDirectory?.trim()
              ? { rootDirectory: dto.rootDirectory.trim() }
              : {}),
            ...(dto.buildCommand?.trim()
              ? { buildCommand: dto.buildCommand.trim() }
              : {}),
            ...(dto.startCommand?.trim()
              ? { startCommand: dto.startCommand.trim() }
              : {}),
            deploymentStrategy,
            ...providerTargetPolicy.providerInput,
            ...(dto.imageUrl?.trim() ? { imageUrl: dto.imageUrl.trim() } : {}),
          })
        : {
            id: this.requireString(dto.providerProjectId, 'providerProjectId'),
            name: this.requireString(
              dto.providerProjectName,
              'providerProjectName',
            ),
            provider: dto.provider,
            metadata: providerTargetPolicy.providerMetadata,
          };

    const created =
      await this.deploymentTargetsRepository.createDeploymentTarget(
        buildCreateTargetPersistInput({
          projectId,
          dto,
          repoFullName: project.repoFullName,
          target,
          providerTargetPolicy,
          deploymentStrategy,
        }),
      );
    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_created',
      title: 'Deployment target created',
      body: `${created.providerProjectName} was attached to this project.`,
      metadata: {
        targetId: created.id,
        provider: created.provider,
        slot: created.slot,
      },
    });
    return created;
  }

  updateProviderMetadata(
    targetId: string,
    providerMetadata: Record<string, unknown>,
    status?: 'active' | 'missing' | 'failed',
  ) {
    return this.deploymentTargetsRepository.updateProviderMetadata(
      targetId,
      providerMetadata,
      status,
    );
  }

  async updateDeploymentTargetMetadata(
    projectId: string,
    targetId: string,
    userId: string,
    input: UpdateDeploymentTargetMetadataInput,
  ) {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    await this.assertProjectMutationAccess(projectId, userId);
    const existingTarget = await this.getOwnedTargetOrThrow(
      projectId,
      targetId,
      userId,
    );
    if (input.slot !== undefined) {
      try {
        assertProviderSlotAllowed(
          existingTarget.provider,
          input.slot,
          this.providerRegistry?.find(existingTarget.provider),
        );
      } catch (error) {
        if (error instanceof DeploymentPolicyViolation) {
          throw new BadRequestException(error.policyError.message);
        }
        throw error;
      }
    }
    const target =
      await this.deploymentTargetsRepository.updateDeploymentTargetMetadataForUser(
        projectId,
        targetId,
        userId,
        this.normalizeMetadataUpdate(input),
      );
    if (!target) {
      throw new NotFoundException('Deployment target not found');
    }

    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_updated',
      title: 'Deployment target updated',
      body: `${target.providerProjectName} metadata was updated.`,
      metadata: {
        targetId: target.id,
        provider: target.provider,
        slot: target.slot,
      },
    });
    return target;
  }

  async syncDeploymentTarget(
    projectId: string,
    targetId: string,
    userId: string,
  ): Promise<{
    mode: 'provider_live' | 'local_metadata';
    status: DeploymentTargetSummary['status'];
    findings: Array<{
      code: string;
      severity: 'warning' | 'error';
      message: string;
    }>;
    target: DeploymentTargetSummary;
  }> {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    await this.assertProjectMutationAccess(projectId, userId);
    let target = await this.getOwnedTargetOrThrow(projectId, targetId, userId);
    const findings: Array<{
      code: string;
      severity: 'warning' | 'error';
      message: string;
    }> = [];

    if (!target.providerProjectId?.trim()) {
      findings.push({
        code: 'provider_project_id_missing',
        severity: 'warning',
        message: 'Provider project ID is not tracked for this target.',
      });
    }
    if (!target.branchName?.trim()) {
      findings.push({
        code: 'target_branch_missing',
        severity: 'warning',
        message: 'Branch metadata is not tracked for this target.',
      });
    }

    let mode: 'provider_live' | 'local_metadata' = 'local_metadata';
    if (target.providerProjectId?.trim()) {
      try {
        const { token } = await this.resolveProviderToken(
          target.provider,
          userId,
          this.tokenResolutionInputFor(target),
        );
        const status = await this.clientRegistry
          .getClient(target.provider)
          .getTargetStatus({
            token,
            targetId: target.providerProjectId,
            ...this.providerOperationInput(target),
          });
        mode = 'provider_live';
        if (!status.exists) {
          findings.push({
            code: 'provider_resource_missing',
            severity: 'error',
            message: `The ${target.provider} resource for this target no longer exists — it may have been deleted outside ALPHACI.`,
          });
        }
        // Backfill provider-specific fields (e.g. Render's ownerId) the live
        // check discovered but this target was never given — most commonly
        // targets registered via "use existing target" rather than created
        // by ALPHACI. This is what lets real log fetching self-heal on the
        // next sync instead of requiring a one-off registration-time fix.
        const discovered = Object.entries(status.metadata ?? {}).filter(
          ([key, value]) => Boolean(value) && !target.providerMetadata?.[key],
        );
        if (discovered.length > 0) {
          target =
            await this.deploymentTargetsRepository.updateProviderMetadata(
              target.id,
              { ...target.providerMetadata, ...Object.fromEntries(discovered) },
            );
        }
      } catch {
        mode = 'local_metadata';
        findings.push({
          code: 'provider_live_check_failed',
          severity: 'warning',
          message: `Could not reach ${target.provider} to verify live status — showing locally tracked metadata only.`,
        });
      }
    }

    const response = {
      mode,
      status: findings.length > 0 ? 'missing' : target.status,
      findings,
      target,
    };
    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_synced',
      title: 'Deployment target synced',
      body: `${target.providerProjectName} metadata was checked.`,
      metadata: {
        targetId: target.id,
        provider: target.provider,
        status: response.status,
        mode,
        findingCount: findings.length,
      },
    });
    return response;
  }

  async detachDeploymentTarget(
    projectId: string,
    targetId: string,
    userId: string,
    options?: DetachDeploymentTargetDto,
  ): Promise<{
    detached: true;
    providerResourceDeleted: boolean;
    providerDeleteError?: string;
  }> {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    const requiresProviderDelete = options?.deleteProviderResource === true;
    await this.assertProjectMutationAccess(
      projectId,
      userId,
      requiresProviderDelete
        ? ['admin', 'delegated_lead']
        : ['admin', 'delegated_lead', 'member'],
    );
    // Load the target row before deleting anything locally — we need
    // providerProjectId/provider/ownershipMode/providerConnectionId to
    // attempt the live provider delete below, and the row disappears once
    // deleteDeploymentTargetForUser runs.
    const target = await this.getOwnedTargetOrThrow(
      projectId,
      targetId,
      userId,
    );

    let providerResourceDeleted = false;
    let providerDeleteError: string | undefined;
    if (requiresProviderDelete && target.providerProjectId?.trim()) {
      try {
        const { token } = await this.resolveProviderToken(
          target.provider,
          userId,
          this.tokenResolutionInputFor(target),
        );
        const result = await this.clientRegistry
          .getClient(target.provider)
          .deleteTarget({ token, targetId: target.providerProjectId });
        providerResourceDeleted = result.deleted;
      } catch (error) {
        // A failed provider call must never block the local detach — the
        // user should never be stuck unable to detach because a third-party
        // API had a bad moment.
        providerDeleteError = this.truncateErrorMessage(error);
      }
    }

    const deleted =
      await this.deploymentTargetsRepository.deleteDeploymentTargetForUser(
        projectId,
        targetId,
        userId,
      );
    if (!deleted) {
      throw new NotFoundException('Deployment target not found');
    }

    const body = providerResourceDeleted
      ? `${target.providerProjectName} and its live ${target.provider} resource were both removed.`
      : providerDeleteError
        ? `${target.providerProjectName} was detached from ALPHACI; local tracking removed, but the live resource could not be deleted automatically.`
        : 'Deployment target metadata was removed from ALPHACI.';

    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_detached',
      title: 'Deployment target detached',
      body,
      metadata: {
        targetId,
        deleteProviderResourceRequested: requiresProviderDelete,
        providerResourceDeleted,
        ...(providerDeleteError ? { providerDeleteError } : {}),
      },
    });
    return {
      detached: true,
      providerResourceDeleted,
      ...(providerDeleteError ? { providerDeleteError } : {}),
    };
  }

  /**
   * Deletes the live provider resource of every target on the project, for
   * project deletion. Leaves the target rows alone — the caller's project
   * delete cascades them — and never throws for a provider failure.
   */
  async deleteProviderResourcesForProject(
    projectId: string,
    userId: string,
  ): Promise<ProviderResourcesTeardownResult> {
    await this.getProjectOrThrow(projectId, userId);
    const targets =
      await this.deploymentTargetsRepository.listDeploymentTargets(projectId);

    const result: ProviderResourcesTeardownResult = { deleted: [], failed: [] };
    for (const target of targets) {
      if (!target.providerProjectId?.trim()) {
        continue;
      }
      const ref = {
        targetId: target.id,
        provider: target.provider,
        providerProjectName: target.providerProjectName,
      };
      try {
        const { token } = await this.resolveProviderToken(
          target.provider,
          userId,
          this.tokenResolutionInputFor(target),
        );
        const deleted = await this.clientRegistry
          .getClient(target.provider)
          .deleteTarget({ token, targetId: target.providerProjectId });
        if (deleted.deleted) {
          result.deleted.push(ref);
        } else {
          result.failed.push({
            ...ref,
            message: `${target.provider} reported the resource was not deleted.`,
          });
        }
      } catch (error) {
        result.failed.push({
          ...ref,
          message: this.truncateErrorMessage(error),
        });
      }
    }

    if (result.deleted.length > 0 || result.failed.length > 0) {
      await this.recordTargetEvent({
        userId,
        projectId,
        eventCode: 'deployment_provider_resources_deleted',
        title: 'Deployment provider resources deleted',
        body:
          result.failed.length === 0
            ? `Deleted ${result.deleted.length} live provider resource(s) as part of project deletion.`
            : `Deleted ${result.deleted.length} live provider resource(s); ${result.failed.length} could not be deleted and must be removed manually.`,
        metadata: { deleted: result.deleted, failed: result.failed },
      });
    }

    return result;
  }

  async getDeploymentTargetActions(
    projectId: string,
    targetId: string,
    userId: string,
  ) {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    const target = await this.getOwnedTargetOrThrow(
      projectId,
      targetId,
      userId,
    );

    return {
      targetId: target.id,
      provider: target.provider,
      actions: {
        // Capability descriptor, not an outcome: mirrors what
        // syncDeploymentTarget will *attempt* — a live provider check when a
        // providerProjectId is tracked (outcome still depends on live
        // reachability at call time), or a local-metadata-only check when
        // there's nothing to look up against.
        sync: {
          enabled: true,
          mode: target.providerProjectId?.trim()
            ? ('provider_live' as const)
            : ('local_metadata' as const),
        },
        detach: {
          enabled: true,
        },
        reinstallDeploymentSecrets: {
          enabled: false,
          reason: 'Provider activation required',
        },
        openProviderDashboard: {
          enabled: this.providerDashboardUrl(target) !== null,
          url: this.providerDashboardUrl(target),
        },
        openProviderConsole: {
          enabled: this.providerConsoleUrl(target) !== null,
          url: this.providerConsoleUrl(target),
        },
      },
    };
  }

  private async getProjectOrThrow(
    projectId: string,
    userId: string,
  ): Promise<DeploymentProjectReference> {
    const project = await this.projectReferenceLookup.findProjectReference(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  private async assertProjectMutationAccess(
    projectId: string,
    userId: string,
    roles: WorkspaceRole[] = ['admin', 'delegated_lead', 'member'],
  ): Promise<void> {
    await this.workspaceAccessService?.assertProjectRole(
      projectId,
      userId,
      roles,
    );
  }

  private truncateErrorMessage(error: unknown, maxLength = 300): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > maxLength
      ? `${message.slice(0, maxLength)}...`
      : message;
  }

  private tokenResolutionInputFor(target: DeploymentTargetSummary): {
    ownershipMode: string;
    providerConnectionId?: string;
  } {
    return {
      ownershipMode: target.ownershipMode,
      ...(target.providerConnectionId
        ? { providerConnectionId: target.providerConnectionId }
        : {}),
    };
  }

  private async assertWithinQuota(
    userId: string,
    projectId: string,
    limitCode: string,
  ): Promise<void> {
    try {
      await this.usageQuotaService?.assertWithinLimit(userId, limitCode);
    } catch (error) {
      await this.recordTargetEvent({
        userId,
        projectId,
        eventCode: 'quota_blocked',
        title: 'Quota blocked action',
        body: `Quota ${limitCode} blocked this action.`,
        metadata: { limitCode },
      });
      throw error;
    }
  }

  /**
   * Enforce the single ownership mode this deployment offers (see
   * capabilities.controller and ENV_PROVISIONING_OWNERSHIP_MODE):
   *  - 'flowci_managed' (internal): deployments are centralized on the
   *    organization's Render/Vercel; bring-your-own is not available.
   *  - 'byo' (external/sold): managed hosting is archived; users connect their
   *    own provider accounts.
   */
  private assertOwnershipModeAllowed(dto: CreateDeploymentTargetDto): void {
    const configuredMode =
      this.configService.getOrThrow<AppConfig>('app').envProvisioning
        .ownershipMode;

    if (configuredMode === 'flowci_managed') {
      if (dto.ownershipMode !== 'flowci_managed') {
        throw new BadRequestException(
          `This workspace centralizes deployments on the organization's ${dto.provider} account. Bring-your-own ${dto.provider} hosting is not available here.`,
        );
      }
      return;
    }

    if (dto.ownershipMode === 'flowci_managed') {
      throw new BadRequestException(
        `Managed ${dto.provider} hosting is archived. Connect your own ${dto.provider} account and use BYO hosting for new targets.`,
      );
    }
  }

  /**
   * Records a target that could NOT be provisioned, on the same channel the
   * successful one uses.
   *
   * Provisioning a target that fails leaves nothing behind: the row is never
   * written, so the database shows no trace, and the only evidence is a
   * `logger.warn` on a server nobody is watching. A React project reached
   * production that way - three Vercel deploy jobs committed to its
   * repository, zero deployment targets stored, a green "project created", and
   * the deploy failing days later in another repository with an error naming
   * none of it. Working out why took reading the provisioning source; it
   * should have taken one query.
   *
   * An event rather than a `failed` row on purpose. Other code reads the
   * targets table to decide what a pipeline deploys to, and a row that looks
   * like a target but is not one would be a worse bug than the silence it
   * replaces.
   */
  async recordTargetProvisioningFailure(input: {
    userId: string;
    projectId: string;
    provider: string;
    slot: string;
    reason: string;
  }): Promise<void> {
    await this.recordTargetEvent({
      userId: input.userId,
      projectId: input.projectId,
      eventCode: 'deployment_target_failed',
      title: 'Deployment target could not be provisioned',
      body:
        `${input.provider} (${input.slot}) was not created: ${input.reason}. ` +
        `The pipeline still contains deploy jobs for it, and they will run ` +
        `with nothing to deploy to.`,
      metadata: {
        provider: input.provider,
        slot: input.slot,
        reason: input.reason,
      },
    });
  }

  private async recordTargetEvent(input: {
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
    try {
      await this.notificationEventsService?.record({
        userId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        title: input.title,
        body: input.body,
      });
    } catch (error) {
      // A notification failure must never surface as a failure of the
      // mutation that already committed (e.g. detach already deleted the
      // row) — mirrors AuditEventPublisher.recordProjectEvent's
      // self-protecting try/catch, which notificationEventsService.record()
      // itself does not have.
      this.logger.warn(
        `Notification event '${input.eventCode}' was not recorded: ${String(error)}`,
      );
    }
  }

  private async getOwnedTargetOrThrow(
    projectId: string,
    targetId: string,
    userId: string,
  ): Promise<DeploymentTargetSummary> {
    await this.getProjectOrThrow(projectId, userId);
    const target =
      await this.deploymentTargetsRepository.findDeploymentTargetForUser(
        targetId,
        userId,
      );
    if (!target || target.projectId !== projectId) {
      throw new NotFoundException('Deployment target not found');
    }

    return target;
  }

  private projectTargetManagementEnabled(): boolean {
    const config = this.configService.getOrThrow<AppConfig>('app');
    return config.projectTargetManagement?.enabled ?? false;
  }

  private normalizeMetadataUpdate(
    input: UpdateDeploymentTargetMetadataInput,
  ): UpdateDeploymentTargetMetadataInput {
    const normalized: UpdateDeploymentTargetMetadataInput = {};
    if (input.slot !== undefined) {
      normalized.slot = this.requireTargetSlot(input.slot);
    }
    if (input.providerProjectName !== undefined) {
      normalized.providerProjectName = this.requireString(
        input.providerProjectName,
        'providerProjectName',
      );
    }
    if (input.branchName !== undefined) {
      normalized.branchName = this.requireString(
        input.branchName,
        'branchName',
      );
    }
    if (input.rootDirectory !== undefined) {
      normalized.rootDirectory = input.rootDirectory?.trim() || null;
    }
    if (input.buildCommand !== undefined) {
      normalized.buildCommand = input.buildCommand?.trim() || null;
    }
    if (input.startCommand !== undefined) {
      normalized.startCommand = input.startCommand?.trim() || null;
    }
    if (input.renderEnvironmentName !== undefined) {
      normalized.renderEnvironmentName =
        input.renderEnvironmentName === null
          ? null
          : this.requireRenderEnvironment(input.renderEnvironmentName);
    }

    return normalized;
  }

  private requireTargetSlot(value: unknown): EnvTargetSlot {
    if (value === 'backend' || value === 'frontend' || value === 'standalone') {
      return value;
    }

    throw new BadRequestException(
      'slot must be backend, frontend, or standalone',
    );
  }

  private requireRenderEnvironment(value: unknown): RenderEnvironmentName {
    if (value === 'test' || value === 'uat' || value === 'production') {
      return value;
    }

    throw new BadRequestException(
      'renderEnvironmentName must be test, uat, or production',
    );
  }

  private providerDashboardUrl(target: DeploymentTargetSummary): string | null {
    const presentation = this.providerPresentation(target);
    return presentation?.dashboardUrl(this.presentationTarget(target)) ?? null;
  }

  private providerConsoleUrl(target: DeploymentTargetSummary): string | null {
    const presentation = this.providerPresentation(target);
    return presentation?.consoleUrl(this.presentationTarget(target)) ?? null;
  }

  private providerPublicUrl(target: DeploymentTargetSummary): string | null {
    const presentation = this.providerPresentation(target);
    return (
      presentation?.publicUrl(
        this.presentationTarget(target),
        target.renderEnvironmentName === 'production' ||
          target.branchName === 'main'
          ? 'production'
          : 'preview',
      ) ?? null
    );
  }

  private providerPresentation(target: DeploymentTargetSummary) {
    return this.providerRegistry?.find(target.provider)?.presentation;
  }

  private presentationTarget(target: DeploymentTargetSummary) {
    return {
      providerProjectId: target.providerProjectId,
      providerProjectName: target.providerProjectName,
      providerMetadata: target.providerMetadata,
      branchName: target.branchName,
    };
  }

  private async resolveProviderToken(
    provider: EnvProvider,
    userId: string,
    input: {
      ownershipMode: string;
      providerConnectionId?: string;
    },
  ): Promise<{ token: string; connectionMetadata: Record<string, unknown> }> {
    if (input.ownershipMode === 'flowci_managed') {
      const config = this.configService.getOrThrow<AppConfig>('app');
      const policy = this.providerPolicy(provider);
      if (!policy) {
        throw new BadRequestException(
          `ALPHACI-managed ${provider} provisioning is not supported`,
        );
      }
      return {
        token: policy.resolveManagedToken({
          managedConfig: this.managedProviderConfig(config),
        }),
        connectionMetadata: {},
      };
    }

    if (!input.providerConnectionId) {
      throw new BadRequestException('providerConnectionId is required');
    }
    const connection =
      await this.providerConnectionsRepository.findActiveProviderConnection(
        input.providerConnectionId,
        userId,
      );
    if (!connection || connection.provider !== provider) {
      throw new NotFoundException('Provider connection not found');
    }

    return {
      token: this.encryptionService.decrypt(connection.encryptedToken),
      connectionMetadata: connection.metadata,
    };
  }

  private providerPolicy(
    provider: EnvProvider,
  ): DeploymentProviderPolicy | undefined {
    return this.providerRegistry?.find(provider)?.policy;
  }

  private managedProviderConfig(
    config = this.configService.getOrThrow<AppConfig>('app'),
  ): Record<string, unknown> {
    return config.envProvisioning.flowciManaged;
  }

  private requireString(value: string | undefined, field: string): string {
    if (!value?.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  async getDeploymentTargetLogs(
    projectId: string,
    targetId: string,
    userId: string,
    filters?: { type?: string; startTime?: string; endTime?: string },
  ): Promise<{
    logs: DeploymentTargetLogEntry[];
    source: 'live' | 'simulated';
    reason?: string;
  }> {
    const target =
      await this.deploymentTargetsRepository.findDeploymentTargetForUser(
        targetId,
        userId,
      );
    if (!target || target.projectId !== projectId) {
      throw new NotFoundException('Deployment target not found');
    }

    const client = this.clientRegistry.getClient(target.provider);
    if (!client.getLogs) {
      return {
        source: 'simulated',
        reason: `Live log fetching is not supported for ${target.provider}.`,
        logs: this.getMockLogs(target),
      };
    }

    try {
      const { token } = await this.resolveProviderToken(
        target.provider,
        userId,
        {
          ownershipMode: target.ownershipMode,
          ...(target.providerConnectionId
            ? { providerConnectionId: target.providerConnectionId }
            : {}),
        },
      );
      const logs = await client.getLogs({
        token,
        targetId: target.providerProjectId,
        ...filters,
        ...this.providerOperationInput(target),
      });
      // An empty array here is a legitimate live result (a quiet deployment
      // with no recent log lines) — getLogs() throws instead of returning []
      // for cases that aren't actually "live", like a missing Render owner
      // ID, so reaching this point at all means the fetch succeeded.
      return { source: 'live', logs };
    } catch (err) {
      this.logger.warn(
        `Failed to retrieve ${target.provider} logs: ${(err as Error).message}`,
      );
      return {
        source: 'simulated',
        reason: (err as Error).message,
        logs: this.getMockLogs(target),
      };
    }
  }

  /**
   * An authenticated handle on one target's provider, for callers that need to
   * act on the provider outside this service.
   *
   * Exposed rather than reimplemented: ownership, provider-token resolution and
   * the Vercel team scope are three things that must not drift between
   * callers, and each has a way of being subtly wrong on its own - a missing
   * ownership check leaks another workspace's target, a missing team scope
   * silently addresses the wrong Vercel account.
   */
  async providerContextForTarget(
    projectId: string,
    targetId: string,
    userId: string,
  ): Promise<{
    target: DeploymentTargetSummary;
    token: string;
    scope: { vercelTeamId?: string; vercelTeamSlug?: string };
  }> {
    const target = await this.getOwnedTargetOrThrow(
      projectId,
      targetId,
      userId,
    );
    const { token } = await this.resolveProviderToken(
      target.provider,
      userId,
      this.tokenResolutionInputFor(target),
    );

    return {
      target,
      token,
      scope: this.providerOperationInput(target),
    };
  }
  private providerOperationInput(
    target: DeploymentTargetSummary,
  ): Record<string, unknown> {
    const policy = this.providerPolicy(target.provider);
    if (!policy) {
      return {};
    }
    return policy.resolveOperationInput({
      ownershipMode: target.ownershipMode ?? 'byo',
      providerMetadata: target.providerMetadata ?? {},
      managedConfig: this.managedProviderConfig(),
    });
  }

  private getMockLogs(
    target: DeploymentTargetSummary,
  ): DeploymentTargetLogEntry[] {
    const providerLogs = this.providerPolicy(
      target.provider,
    )?.resolveMockLogs?.({
      providerProjectName: target.providerProjectName || null,
      now: new Date(),
    });
    if (providerLogs) return [...providerLogs];

    return [
      {
        timestamp: new Date().toISOString(),
        message: `Live logs are not available for ${target.provider}.`,
        level: 'info',
      },
    ];
  }
}
