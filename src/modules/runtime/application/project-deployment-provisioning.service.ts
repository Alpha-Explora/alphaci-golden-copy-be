import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type {
  DeploymentProvisioningEnvSet as DeploymentProvisioningEnvSetDto,
  DeploymentProvisioningInput,
  DeploymentProvisioningRequest as DeploymentProvisioningRequestDto,
  DeploymentProvisioningResult,
  DeploymentProvisioningTarget as DeploymentProvisioningTargetDto,
  DeploymentProvisioningFacade,
} from '../core/deployment-provisioning.contract';
import { DeploymentTargetsService } from './deployment-targets.service';
import type { EnvLane, EnvVarScope } from '../core/deployments.types';
import { DeploymentProviderPolicyRegistry } from '../domain/deployment-provider.policy';
import { EnvVarsService } from './env-vars.service';
import {
  PROVIDER_CI_SECRETS_INSTALLER_REGISTRY,
  type ProviderCiSecretsInstallerRegistryPort,
} from './ports/provider-ci-secrets-installer.port';
import {
  requestedBranch,
  toCreateDeploymentTargetDto,
} from './provision-for-project.mapping';

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
type CreatedDeploymentTarget = Awaited<
  ReturnType<DeploymentTargetsService['createDeploymentTarget']>
>;

@Injectable()
export class ProjectDeploymentProvisioningService implements DeploymentProvisioningFacade {
  private readonly logger = new Logger(
    ProjectDeploymentProvisioningService.name,
  );

  constructor(
    private readonly deploymentTargetsService: DeploymentTargetsService,
    private readonly envVarsService: EnvVarsService,
    @Inject(PROVIDER_CI_SECRETS_INSTALLER_REGISTRY)
    private readonly ciSecretsInstallers: ProviderCiSecretsInstallerRegistryPort,
    @Optional()
    private readonly providerPolicyRegistry?: DeploymentProviderPolicyRegistry,
  ) {}

  async provisionForProject(
    input: ProvisionForProjectInput,
  ): Promise<DeploymentProvisioningResult> {
    if (!input.request?.enabled || input.request.targets.length === 0) {
      return { status: 'skipped', targets: [] };
    }

    const targets: DeploymentProvisioningResult['targets'] = [];
    const requestedTargets = this.expandTargets(input.request);

    for (const requestedTarget of requestedTargets) {
      try {
        const defaultImageUrl = this.defaultManagedImageUrl(
          input.repoFullName,
          requestedTarget,
        );
        const targetRequest = toCreateDeploymentTargetDto(
          requestedTarget,
          defaultImageUrl,
        );

        const target =
          await this.deploymentTargetsService.createDeploymentTarget(
            input.projectId,
            input.userId,
            targetRequest,
          );
        const providerMetadata = await this.installCiSecretsIfSupported({
          githubAccessToken: input.githubAccessToken,
          repoFullName: input.repoFullName,
          userId: input.userId,
          providerConnectionId: requestedTarget.providerConnectionId,
          target,
        });
        const env = await this.provisionEnvForTarget({
          projectId: input.projectId,
          userId: input.userId,
          request: input.request,
          requestedTarget,
          targetId: target.id,
        });

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
        const reason = this.sanitizeError(error);
        this.logger.warn(
          `Deployment provisioning failed for ${input.repoFullName}/${requestedTarget.slot}: ${String(error)}`,
        );
        /*
         * Recorded where the user can see it, not only in the server log.
         *
         * A failed target writes no row, so until this existed the only trace
         * was a warn line - and the deploy jobs generated for that target
         * shipped anyway. Awaited but never allowed to throw: losing the
         * record of a failure must not also lose the results of the targets
         * that succeeded.
         */
        await this.deploymentTargetsService
          .recordTargetProvisioningFailure({
            userId: input.userId,
            projectId: input.projectId,
            provider: requestedTarget.provider,
            slot: requestedTarget.slot,
            reason,
          })
          .catch((recordError: unknown) => {
            this.logger.warn(
              `Could not record the provisioning failure for ${input.repoFullName}: ${String(recordError)}`,
            );
          });
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
          errorSummary: reason,
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

  private async installCiSecretsIfSupported(input: {
    githubAccessToken: string | undefined;
    repoFullName: string;
    userId: string;
    providerConnectionId: string | undefined;
    target: CreatedDeploymentTarget;
  }): Promise<CreatedDeploymentTarget['providerMetadata']> {
    const ciSecretsInstaller = this.ciSecretsInstallers.get(
      input.target.provider,
    );

    /*
     * Declining to install credentials is not a quiet outcome.
     *
     * This returned silently, and the consequence showed up far away: the
     * workflow generator decides whether to emit deploy jobs from the target's
     * OWNERSHIP MODE, while this decides whether to install the secrets those
     * jobs read from its DEPLOYMENT STRATEGY. When the two disagree, a
     * repository gets `deploy-vercel-frontend-uat` referencing
     * `secrets.VERCEL_FRONTEND_TOKEN` that nothing ever set — observed on real
     * projects, for both providers: deploy jobs present, zero provider secrets
     * on the repository, provisioning reported success.
     *
     * The deploy then fails on an empty credential, in another repository, in
     * another workflow, with an error that names none of this.
     *
     * So say it here, where the decision is made, and say which of the two
     * reasons it was. This does not throw: a provider that legitimately needs
     * no CI secrets must still provision. It makes the skip findable, which is
     * the thing that was missing.
     */
    if (!ciSecretsInstaller) {
      this.logger.warn(
        `No CI secrets installer is registered for provider "${input.target.provider}". ` +
          `Deployment jobs generated for ${input.repoFullName} will read secrets that nothing installs.`,
      );
      return input.target.providerMetadata;
    }

    if (!ciSecretsInstaller.supports(input.target)) {
      this.logger.warn(
        `The ${input.target.provider} CI secrets installer declined target ${input.target.id} ` +
          `(strategy "${input.target.deploymentStrategy}", ownership "${input.target.ownershipMode}"). ` +
          `No provider secrets were installed on ${input.repoFullName}, so any deploy job ` +
          `generated for this target will run without credentials.`,
      );
      return input.target.providerMetadata;
    }
    if (!input.githubAccessToken) {
      throw new Error(
        `GitHub access token is required to install ${input.target.provider} deployment secrets`,
      );
    }

    const secretResult = await ciSecretsInstaller.installForTarget({
      githubAccessToken: input.githubAccessToken,
      repoFullName: input.repoFullName,
      userId: input.userId,
      providerConnectionId: input.providerConnectionId ?? null,
      target: input.target,
    });
    const providerMetadata = {
      ...input.target.providerMetadata,
      githubSecrets: secretResult.githubSecrets,
    };
    await this.deploymentTargetsService.updateProviderMetadata(
      input.target.id,
      providerMetadata,
    );
    return providerMetadata;
  }

  private async provisionEnvForTarget(input: {
    projectId: string;
    userId: string;
    request: DeploymentProvisioningRequestDto;
    requestedTarget: DeploymentProvisioningTargetDto;
    targetId: string;
  }): Promise<ProvisionedTarget['env']> {
    const env: ProvisionedTarget['env'] = [];
    for (const envSet of this.resolveEnvSets(
      input.request,
      input.requestedTarget,
      input.requestedTarget.env,
    )) {
      const result = await this.envVarsService.provisionEnvVars(
        input.projectId,
        input.userId,
        {
          deploymentTargetId: input.targetId,
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
    return env;
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

  /** Slot names win; a provider supplies the default for standalone targets. */
  private targetRole(target: ProvisionedTarget): 'backend' | 'frontend' {
    if (target.slot === 'backend' || target.slot === 'frontend') {
      return target.slot;
    }
    return (
      this.providerPolicyRegistry
        ?.find(target.provider)
        ?.provisioning?.resolveDefaultTargetRole() ?? 'backend'
    );
  }

  /** The lane a target serves, or null when it covers both lanes. */
  private crossLinkLane(target: ProvisionedTarget): EnvLane | null {
    const provisioning = this.providerPolicyRegistry?.find(
      target.provider,
    )?.provisioning;
    return provisioning
      ? provisioning.resolveCrossLinkLane({
          branchName: target.branchName ?? null,
          renderEnvironmentName: target.renderEnvironmentName ?? null,
        })
      : 'preview';
  }

  private targetPublicUrl(
    target: ProvisionedTarget,
    lane: EnvLane,
  ): string | null {
    return (
      this.providerPolicyRegistry
        ?.find(target.provider)
        ?.provisioning?.resolvePublicUrl({
          providerProjectId: target.providerProjectId,
          providerProjectName: target.providerProjectName,
          providerMetadata: target.providerMetadata ?? {},
          branchName: target.branchName ?? null,
          lane,
        }) ?? null
    );
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
    for (const target of this.expandTargets(request)) {
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
      {
        scope: EnvVarScope;
        varsByKey: Map<string, { key: string; value: string }>;
      }
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
    return (
      [...mergedByScope.values()]
        .map(({ scope, varsByKey }) => ({
          ...scope,
          vars: [...varsByKey.values()],
        }))
        // A target only deploys its own branch, so a set aimed elsewhere is not
        // this target's to write.
        .filter((envSet) => scopeKey(envSet) === targetScope)
        .filter((envSet) => envSet.vars.length > 0)
    );
  }

  private expandTargets(
    request: DeploymentProvisioningRequestDto,
  ): DeploymentProvisioningTargetDto[] {
    const normalizedTargets = request.targets.map((target) => {
      return (
        this.providerPolicyRegistry
          ?.find(target.provider)
          ?.provisioning?.normalizeTarget(target) ?? target
      );
    });

    return normalizedTargets.flatMap((target) => {
      return (
        this.providerPolicyRegistry
          ?.find(target.provider)
          ?.provisioning?.expandTargets({
            target,
            allTargets: normalizedTargets,
          }) ?? [target]
      );
    });
  }
  private defaultManagedImageUrl(
    repoFullName: string,
    target: DeploymentProvisioningTargetDto,
  ): string | null {
    return (
      this.providerPolicyRegistry
        ?.find(target.provider)
        ?.provisioning?.defaultImageUrl({ repoFullName, target }) ?? null
    );
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
