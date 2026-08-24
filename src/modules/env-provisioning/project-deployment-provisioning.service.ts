import { Injectable, Logger } from '@nestjs/common';

import type {
  DeploymentProvisioningEnvSet as DeploymentProvisioningEnvSetDto,
  DeploymentProvisioningInput,
  DeploymentProvisioningRequest as DeploymentProvisioningRequestDto,
  DeploymentProvisioningResult,
  DeploymentProvisioningTarget as DeploymentProvisioningTargetDto,
  DeploymentProvisioningFacade,
} from './deployment-provisioning.contract';
import { DeploymentTargetsService } from './deployment-targets.service';
import type { CreateDeploymentTargetDto } from './dto/create-deployment-target.dto';
import type { EnvLane, EnvVarScope } from './env-provisioning.types';
import { EnvVarsService } from './env-vars.service';
import { RenderCiSecretsService } from './render-ci-secrets.service';
import { VercelCiSecretsService } from './vercel-ci-secrets.service';

type ProvisionForProjectInput = DeploymentProvisioningInput;

/**
 * One project's provisioning outcome, paired with its project id so the
 * cross-link pass can inject env vars into targets that live on different
 * projects (multi-repo: backend and frontend are separate repos/projects).
 */
export interface CrossLinkGroup {
  projectId: string;
  result: DeploymentProvisioningResult;
}

const CROSS_LINK_LANES = ['preview', 'production'] as const;

const PRODUCTION_SCOPE: EnvVarScope = { lane: 'production', gitBranch: null };

/**
 * The branch a requested target will actually track.
 *
 * Mirrors the default the deployment-target create path applies, so the scope a
 * variable is written under and the scope a user-provided key is recorded under
 * cannot disagree. They did once: the request target carried no branch while
 * the created target defaulted to 'uat', so a user's own CORS_ORIGINS no longer
 * suppressed the cross-link injection meant to defer to it.
 */
const DEFAULT_TARGET_BRANCH = 'uat';

function requestedBranch(target: { branchName?: string }): string {
  return target.branchName?.trim() || DEFAULT_TARGET_BRANCH;
}

/** Map key for a lane/branch pair. Production has no branch, hence the ''. */
function scopeKey(scope: EnvVarScope): string {
  return `${scope.lane}:${scope.gitBranch ?? ''}`;
}

/**
 * A preview scope for `branch`, falling back to production when there is no
 * branch to name.
 *
 * A preview row without a branch is not writable — the database rejects it and
 * so does EnvVarsService.resolveScope — so an unnamed branch has to resolve to
 * the one lane that needs no branch rather than produce an invalid scope.
 */
function previewScope(branch: string | null | undefined): EnvVarScope {
  const trimmed = branch?.trim();
  return trimmed ? { lane: 'preview', gitBranch: trimmed } : PRODUCTION_SCOPE;
}

type ProvisionedTarget = DeploymentProvisioningResult['targets'][number];

@Injectable()
export class ProjectDeploymentProvisioningService
  implements DeploymentProvisioningFacade
{
  private readonly logger = new Logger(
    ProjectDeploymentProvisioningService.name,
  );

  constructor(
    private readonly deploymentTargetsService: DeploymentTargetsService,
    private readonly envVarsService: EnvVarsService,
    private readonly vercelCiSecretsService: VercelCiSecretsService,
    private readonly renderCiSecretsService?: RenderCiSecretsService,
  ) {}

  async provisionForProject(
    input: ProvisionForProjectInput,
  ): Promise<DeploymentProvisioningResult> {
    if (!input.request?.enabled || input.request.targets.length === 0) {
      return { status: 'skipped', targets: [] };
    }

    const targets: DeploymentProvisioningResult['targets'] = [];
    const requestedTargets = this.expandManagedRenderTargets(input.request);

    for (const requestedTarget of requestedTargets) {
      try {
        const defaultImageUrl = this.defaultManagedRenderImageUrl(
          input.repoFullName,
          requestedTarget,
        );
        const targetRequest: CreateDeploymentTargetDto = {
          action:
            requestedTarget.action ??
            (requestedTarget.renderDeployMethod === 'existing_service'
              ? 'register_existing'
              : 'create'),
          slot: requestedTarget.slot,
          ownershipMode: requestedTarget.ownershipMode,
          provider: requestedTarget.provider,
          branchName: requestedBranch(requestedTarget),
          ...(requestedTarget.providerConnectionId
            ? { providerConnectionId: requestedTarget.providerConnectionId }
            : {}),
          ...(requestedTarget.projectName
            ? { projectName: requestedTarget.projectName }
            : {}),
          ...(requestedTarget.providerProjectId
            ? { providerProjectId: requestedTarget.providerProjectId }
            : {}),
          ...(requestedTarget.providerProjectName
            ? { providerProjectName: requestedTarget.providerProjectName }
            : {}),
          ...(requestedTarget.rootDirectory
            ? { rootDirectory: requestedTarget.rootDirectory }
            : {}),
          ...(requestedTarget.buildCommand
            ? { buildCommand: requestedTarget.buildCommand }
            : {}),
          ...(requestedTarget.startCommand
            ? { startCommand: requestedTarget.startCommand }
            : {}),
          ...(requestedTarget.renderDeployMethod
            ? { renderDeployMethod: requestedTarget.renderDeployMethod }
            : {}),
          ...(requestedTarget.renderServiceType
            ? { renderServiceType: requestedTarget.renderServiceType }
            : {}),
          ...(requestedTarget.renderRuntime
            ? { renderRuntime: requestedTarget.renderRuntime }
            : {}),
          ...(requestedTarget.renderInstanceType
            ? { renderInstanceType: requestedTarget.renderInstanceType }
            : {}),
          ...(requestedTarget.renderRegion
            ? { renderRegion: requestedTarget.renderRegion }
            : {}),
          ...(requestedTarget.renderEnvironmentName
            ? { renderEnvironmentName: requestedTarget.renderEnvironmentName }
            : {}),
          ...(requestedTarget.dockerContext
            ? { dockerContext: requestedTarget.dockerContext }
            : {}),
          ...(requestedTarget.dockerfilePath
            ? { dockerfilePath: requestedTarget.dockerfilePath }
            : {}),
          ...(requestedTarget.imageUrl
            ? { imageUrl: requestedTarget.imageUrl }
            : defaultImageUrl
              ? { imageUrl: defaultImageUrl }
              : {}),
        };

        const target =
          await this.deploymentTargetsService.createDeploymentTarget(
            input.projectId,
            input.userId,
            targetRequest,
          );
        let providerMetadata = target.providerMetadata;

        if (target.deploymentStrategy === 'vercel_ci_pushed') {
          if (!input.githubAccessToken) {
            throw new Error(
              'GitHub access token is required to install Vercel deployment secrets',
            );
          }

          const secretResult =
            await this.vercelCiSecretsService.installForTarget({
              githubAccessToken: input.githubAccessToken,
              repoFullName: input.repoFullName,
              userId: input.userId,
              providerConnectionId:
                requestedTarget.providerConnectionId ?? null,
              target,
            });
          providerMetadata = {
            ...target.providerMetadata,
            githubSecrets: secretResult.githubSecrets,
          };
          await this.deploymentTargetsService.updateProviderMetadata(
            target.id,
            providerMetadata,
          );
        }

        if (
          target.provider === 'render' &&
          ['render_image_pushed', 'render_existing_service'].includes(
            target.deploymentStrategy,
          )
        ) {
          if (!input.githubAccessToken) {
            throw new Error(
              'GitHub access token is required to install Render deployment secrets',
            );
          }
          if (!this.renderCiSecretsService) {
            throw new Error(
              'Render deployment secret installer is not configured',
            );
          }

          const secretResult =
            await this.renderCiSecretsService.installForTarget({
              githubAccessToken: input.githubAccessToken,
              repoFullName: input.repoFullName,
              userId: input.userId,
              providerConnectionId:
                requestedTarget.providerConnectionId ?? null,
              target,
            });
          providerMetadata = {
            ...providerMetadata,
            githubSecrets: secretResult.githubSecrets,
          };
          await this.deploymentTargetsService.updateProviderMetadata(
            target.id,
            providerMetadata,
          );
        }

        const env: DeploymentProvisioningResult['targets'][number]['env'] = [];
        for (const envSet of this.resolveEnvSets(
          input.request,
          requestedTarget,
          requestedTarget.env,
        )) {
          const result = await this.envVarsService.provisionEnvVars(
            input.projectId,
            input.userId,
            {
              deploymentTargetId: target.id,
              lane: envSet.lane,
              gitBranch: envSet.gitBranch,
              vars: envSet.vars,
            },
          );

          env.push({
            lane: envSet.lane,
            gitBranch: envSet.gitBranch,
            provisioned: result.provisioned,
            failed: result.failed,
          });
        }

        targets.push({
          slot: requestedTarget.slot,
          provider: requestedTarget.provider,
          ownershipMode: requestedTarget.ownershipMode,
          deploymentStrategy: target.deploymentStrategy,
          status: 'created',
          deploymentTargetId: target.id,
          providerProjectId: target.providerProjectId,
          providerProjectName: target.providerProjectName,
          providerMetadata,
          ...this.renderResultMetadata(target),
          // Carried through so the cross-link pass can name the branch when it
          // writes a preview-lane variable or builds a preview URL.
          branchName: target.branchName,
          errorSummary: null,
          env,
        });
      } catch (error) {
        this.logger.warn(
          `Deployment provisioning failed for ${input.repoFullName}/${requestedTarget.slot}: ${String(error)}`,
        );
        targets.push({
          slot: requestedTarget.slot,
          provider: requestedTarget.provider,
          ownershipMode: requestedTarget.ownershipMode,
          deploymentStrategy: null,
          status: 'failed',
          deploymentTargetId: null,
          providerProjectId: null,
          providerProjectName: null,
          providerMetadata: {},
          errorSummary: this.sanitizeError(error),
          env: [],
        });
      }
    }

    const result: DeploymentProvisioningResult = {
      status: this.aggregateStatus(targets),
      targets,
    };

    // Wire the freshly-created services to each other (API URL on the
    // frontend, allowed origins on the backend). Single-repo shapes carry
    // both slots in this one result; multi-repo does a second pass across
    // repos from the create flow.
    await this.crossLinkServiceUrls({
      userId: input.userId,
      request: input.request,
      groups: [{ projectId: input.projectId, result }],
    });

    return result;
  }

  /**
   * Inject cross-service env vars so users do not have to know provider URLs
   * up front: backend services receive FRONTEND_URL and CORS_ORIGINS pointing
   * at the frontend deployment, frontends receive NEXT_PUBLIC_API_URL and
   * API_URL pointing at the environment-matched backend service (for example
   * https://demo-backend-main.onrender.com for production).
   *
   * Strictly best-effort: keys the user provided themselves are never
   * overwritten, and injection failures degrade to warnings so provisioning
   * never fails because of the convenience pass.
   */
  async crossLinkServiceUrls(input: {
    userId: string;
    request: DeploymentProvisioningRequestDto | undefined;
    groups: CrossLinkGroup[];
  }): Promise<void> {
    if (!input.request?.enabled) {
      return;
    }

    const userKeys = this.userProvidedEnvKeys(input.request);

    const linked = input.groups.flatMap((group) =>
      group.result.targets
        .filter(
          (target) => target.deploymentTargetId && target.status !== 'failed',
        )
        .map((target) => ({ projectId: group.projectId, target })),
    );

    const frontends = linked.filter(
      ({ target }) => this.targetRole(target) === 'frontend',
    );
    const backends = linked.filter(
      ({ target }) => this.targetRole(target) === 'backend',
    );
    if (frontends.length === 0 || backends.length === 0) {
      return;
    }

    for (const { projectId, target } of backends) {
      const lane = this.crossLinkLane(target) ?? 'preview';
      const frontendUrls = [
        ...new Set(
          frontends
            .map(({ target: frontend }) => this.targetPublicUrl(frontend, lane))
            .filter((url): url is string => Boolean(url)),
        ),
      ];
      if (frontendUrls.length === 0) {
        continue;
      }

      await this.injectEnvVars({
        userId: input.userId,
        projectId,
        target,
        scope: this.crossLinkScope(target, lane),
        userKeys,
        vars: [
          { key: 'FRONTEND_URL', value: frontendUrls[0]! },
          { key: 'CORS_ORIGINS', value: frontendUrls.join(',') },
        ],
      });
    }

    for (const { projectId, target } of frontends) {
      const ownLane = this.crossLinkLane(target);
      // A Vercel project serves preview and production from one target, so
      // inject the matching backend URL into each lane it covers.
      const lanes = ownLane ? [ownLane] : [...CROSS_LINK_LANES];

      for (const lane of lanes) {
        const backendUrl = backends
          .map(({ target: backend }) =>
            this.crossLinkLane(backend) === lane ||
            this.crossLinkLane(backend) === null
              ? this.targetPublicUrl(backend, lane)
              : null,
          )
          .find((url): url is string => Boolean(url));
        if (!backendUrl) {
          continue;
        }

        await this.injectEnvVars({
          userId: input.userId,
          projectId,
          target,
          scope: this.crossLinkScope(target, lane),
          userKeys,
          vars: [
            { key: 'NEXT_PUBLIC_API_URL', value: backendUrl },
            { key: 'API_URL', value: backendUrl },
          ],
        });
      }
    }
  }

  /**
   * Scope for a cross-link write. The preview lane needs a branch, and the only
   * one that makes sense is the branch the target itself deploys.
   */
  private crossLinkScope(
    target: ProvisionedTarget,
    lane: EnvLane,
  ): EnvVarScope {
    return lane === 'production'
      ? PRODUCTION_SCOPE
      : previewScope(target.branchName);
  }

  private async injectEnvVars(input: {
    userId: string;
    projectId: string;
    target: ProvisionedTarget;
    scope: EnvVarScope;
    userKeys: Set<string>;
    vars: Array<{ key: string; value: string }>;
  }): Promise<void> {
    const key = scopeKey(input.scope);
    const vars = input.vars.filter(
      (variable) => !input.userKeys.has(`${key}:${variable.key}`),
    );
    if (vars.length === 0 || !input.target.deploymentTargetId) {
      return;
    }

    try {
      const result = await this.envVarsService.provisionEnvVars(
        input.projectId,
        input.userId,
        {
          deploymentTargetId: input.target.deploymentTargetId,
          ...input.scope,
          vars,
        },
      );
      input.target.env.push({
        ...input.scope,
        provisioned: result.provisioned,
        failed: result.failed,
      });
    } catch (error) {
      this.logger.warn(
        `Cross-service env injection failed for target ${input.target.deploymentTargetId} (${key}): ${this.sanitizeError(error)}`,
      );
    }
  }

  /**
   * Slot names win; 'standalone' targets fall back to the provider's typical
   * role (Render hosts services, Vercel hosts frontends).
   */
  private targetRole(target: ProvisionedTarget): 'backend' | 'frontend' {
    if (target.slot === 'backend' || target.slot === 'frontend') {
      return target.slot;
    }
    return target.provider === 'vercel' ? 'frontend' : 'backend';
  }

  /**
   * The lane a target serves, or null when one provider target covers both
   * (Vercel: preview + production in one project).
   */
  private crossLinkLane(target: ProvisionedTarget): EnvLane | null {
    if (target.provider === 'vercel') {
      return null;
    }
    return target.renderEnvironmentName === 'production'
      ? 'production'
      : 'preview';
  }

  private targetPublicUrl(
    target: ProvisionedTarget,
    lane: EnvLane,
  ): string | null {
    const metadata = target.providerMetadata ?? {};
    if (target.provider === 'render') {
      const metadataUrl = metadata['renderServiceUrl'];
      if (typeof metadataUrl === 'string' && metadataUrl.trim()) {
        return metadataUrl.trim();
      }
      return target.providerProjectName
        ? `https://${target.providerProjectName}.onrender.com`
        : null;
    }

    if (!target.providerProjectName) {
      return null;
    }
    const productionUrl = `https://${target.providerProjectName}.vercel.app`;
    if (lane === 'production') {
      return productionUrl;
    }
    // Vercel's branch alias needs both the team slug and the branch. The
    // branch used to be hardcoded to 'uat' here, which pointed every preview
    // cross-link at a branch that no longer exists; it now follows the target.
    const teamSlug = metadata['vercelTeamSlug'];
    const branch = target.branchName?.trim();
    return typeof teamSlug === 'string' && teamSlug.trim() && branch
      ? `https://${target.providerProjectName}-git-${this.vercelBranchSlug(branch)}-${teamSlug.trim()}.vercel.app`
      : productionUrl;
  }

  /** Vercel lowercases a branch and replaces every non-alphanumeric run with '-'. */
  private vercelBranchSlug(branch: string): string {
    return branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** Keys the user set anywhere in the request, per scope, so the cross-link
   * pass never overrides an explicit choice. */
  private userProvidedEnvKeys(
    request: DeploymentProvisioningRequestDto,
  ): Set<string> {
    const keys = new Set<string>();
    const collect = (
      envSets: DeploymentProvisioningEnvSetDto[] | undefined,
      target: DeploymentProvisioningTargetDto,
    ) => {
      for (const envSet of envSets ?? []) {
        const key = scopeKey(this.envSetScope(envSet, target));
        for (const variable of envSet.vars ?? []) {
          if (variable.key) {
            keys.add(`${key}:${variable.key}`);
          }
        }
      }
    };

    // Shared and grouped sets have no target of their own, so they are
    // resolved once per target — an omitted preview branch means "this
    // target's branch", which differs per target.
    // The expanded list, not request.targets: managed Render targets fan out
    // to one target per branch, and each fan-out branch is its own scope.
    for (const target of this.expandManagedRenderTargets(request)) {
      collect(request.sharedEnv, target);
      for (const group of request.variableGroups ?? []) {
        collect(group.env, target);
      }
      collect(target.env, target);
    }

    return keys;
  }

  private resolveEnvSets(
    request: DeploymentProvisioningRequestDto,
    target: DeploymentProvisioningTargetDto,
    targetEnvSets: DeploymentProvisioningEnvSetDto[] | undefined,
  ): Array<EnvVarScope & { vars: Array<{ key: string; value: string }> }> {
    const mergedByScope = new Map<
      string,
      { scope: EnvVarScope; varsByKey: Map<string, { key: string; value: string }> }
    >();

    for (const envSet of request.sharedEnv ?? []) {
      this.mergeEnvSet(mergedByScope, envSet, target);
    }
    for (const group of request.variableGroups ?? []) {
      if (!this.variableGroupAppliesToTarget(group, target)) {
        continue;
      }
      for (const envSet of group.env ?? []) {
        this.mergeEnvSet(mergedByScope, envSet, target);
      }
    }
    for (const envSet of targetEnvSets ?? []) {
      this.mergeEnvSet(mergedByScope, envSet, target);
    }

    const targetScope = scopeKey(this.targetScope(target));
    return [...mergedByScope.values()]
      .map(({ scope, varsByKey }) => ({
        ...scope,
        vars: [...varsByKey.values()],
      }))
      // A target only deploys its own branch, so a set aimed elsewhere is not
      // this target's to write.
      .filter((envSet) => scopeKey(envSet) === targetScope)
      .filter((envSet) => envSet.vars.length > 0);
  }

  private expandManagedRenderTargets(
    request: DeploymentProvisioningRequestDto,
  ): DeploymentProvisioningTargetDto[] {
    const normalizedTargets = request.targets.map((target) => {
      if (target.branchName !== 'test') {
        return target;
      }

      const projectName = this.renderProjectNameForBranch(target, 'uat');
      return {
        ...target,
        branchName: 'uat' as const,
        ...(projectName ? { projectName } : {}),
        ...(target.provider === 'render'
          ? { renderEnvironmentName: 'uat' as const }
          : {}),
      };
    });

    return normalizedTargets.flatMap((target) => {
      if (!this.shouldFanOutRenderTarget(target, normalizedTargets)) {
        return [target];
      }

      return (['uat', 'main'] as const).map((branchName) => {
        const projectName = this.renderProjectNameForBranch(target, branchName);
        return {
          ...target,
          branchName,
          ...(projectName ? { projectName } : {}),
          renderEnvironmentName:
            branchName === 'main' ? 'production' : branchName,
        };
      });
    });
  }

  private shouldFanOutRenderTarget(
    target: DeploymentProvisioningTargetDto,
    allTargets: DeploymentProvisioningTargetDto[],
  ): boolean {
    if (
      target.provider !== 'render' ||
      target.ownershipMode !== 'flowci_managed' ||
      target.renderDeployMethod === 'existing_service'
    ) {
      return false;
    }

    const renderSiblings = allTargets.filter(
      (candidate) =>
        candidate.provider === 'render' &&
        candidate.ownershipMode === target.ownershipMode &&
        candidate.slot === target.slot,
    );
    const explicitlyStaged = new Set(
      renderSiblings
        .map((candidate) => candidate.branchName)
        .filter((branch): branch is string => Boolean(branch)),
    );

    return explicitlyStaged.size <= 1;
  }

  private renderProjectNameForBranch(
    target: DeploymentProvisioningTargetDto,
    branchName: 'uat' | 'main',
  ): string | undefined {
    const raw = target.projectName?.trim();
    if (!raw) {
      return undefined;
    }

    const base = raw.replace(/-(test|uat|main|production)$/i, '');
    return `${base}-${branchName}`;
  }

  private defaultManagedRenderImageUrl(
    repoFullName: string,
    target: DeploymentProvisioningTargetDto,
  ): string | null {
    if (
      target.provider !== 'render' ||
      target.ownershipMode !== 'flowci_managed' ||
      target.renderDeployMethod === 'native_git' ||
      target.renderDeployMethod === 'existing_service'
    ) {
      return null;
    }

    const [owner] = repoFullName.split('/');
    if (!owner) {
      return null;
    }

    const branchName =
      target.branchName === 'uat' || target.branchName === 'main'
        ? target.branchName
        : 'uat';
    const imageName = `alphaci-${target.slot}-${branchName}-${
      target.projectName ?? target.slot
    }`
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');

    return `ghcr.io/${owner.toLowerCase()}/${imageName}:${branchName}`;
  }

  private variableGroupAppliesToTarget(
    group: NonNullable<
      DeploymentProvisioningRequestDto['variableGroups']
    >[number],
    target: DeploymentProvisioningTargetDto,
  ): boolean {
    if (group.provider && group.provider !== target.provider) {
      return false;
    }

    if ((group.appliesTo ?? 'all') === 'all') {
      return true;
    }

    return (group.targetBranches ?? []).includes(this.targetBranchKey(target));
  }

  private targetBranchKey(target: DeploymentProvisioningTargetDto): string {
    return `${target.slot}:${target.provider}:${target.branchName ?? 'uat'}`;
  }

  /**
   * The lane and branch a requested target's variables belong to.
   *
   * `main` is the production branch, so it takes the branchless production
   * lane; anything else is a preview scoped to its own branch. Replaces the old
   * mapping, which funnelled every non-main branch into a single 'uat' bucket
   * and so could not tell two branches apart.
   */
  private targetScope(target: DeploymentProvisioningTargetDto): EnvVarScope {
    if (target.renderEnvironmentName === 'production') {
      return PRODUCTION_SCOPE;
    }
    if (requestedBranch(target) === 'main') {
      return PRODUCTION_SCOPE;
    }
    return previewScope(requestedBranch(target));
  }

  /**
   * An env set's scope, defaulting an omitted preview branch to the branch the
   * target tracks — the wizard is configuring the branch it just set up.
   */
  private envSetScope(
    envSet: DeploymentProvisioningEnvSetDto,
    target: DeploymentProvisioningTargetDto,
  ): EnvVarScope {
    if (envSet.lane === 'production') {
      return PRODUCTION_SCOPE;
    }
    return previewScope(envSet.gitBranch ?? requestedBranch(target));
  }

  private mergeEnvSet(
    mergedByScope: Map<
      string,
      {
        scope: EnvVarScope;
        varsByKey: Map<string, { key: string; value: string }>;
      }
    >,
    envSet: DeploymentProvisioningEnvSetDto,
    target: DeploymentProvisioningTargetDto,
  ): void {
    const scope = this.envSetScope(envSet, target);
    const key = scopeKey(scope);
    const entry = mergedByScope.get(key) ?? {
      scope,
      varsByKey: new Map<string, { key: string; value: string }>(),
    };

    for (const variable of envSet.vars ?? []) {
      if (variable.key && variable.value !== '') {
        entry.varsByKey.set(variable.key, variable);
      }
    }

    mergedByScope.set(key, entry);
  }

  private aggregateStatus(
    targets: DeploymentProvisioningResult['targets'],
  ): DeploymentProvisioningResult['status'] {
    if (targets.length === 0) {
      return 'skipped';
    }

    const failedCount = targets.filter(
      (target) => target.status === 'failed',
    ).length;
    if (failedCount === 0) {
      return 'completed';
    }

    return failedCount === targets.length ? 'failed' : 'partial';
  }

  private renderResultMetadata(target: {
    renderServiceType?: unknown;
    renderRuntime?: unknown;
    renderInstanceType?: unknown;
    renderRegion?: unknown;
    renderEnvironmentName?: unknown;
    dockerContext?: unknown;
    dockerfilePath?: unknown;
    imageUrl?: unknown;
  }): Record<string, string | null> {
    const metadata: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(target)) {
      if (typeof value === 'string' || value === null) {
        metadata[key] = value;
      }
    }

    return metadata;
  }

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
  }
}
