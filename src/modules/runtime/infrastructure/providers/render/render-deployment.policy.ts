import { BadRequestException, Injectable } from '@nestjs/common';

import type {
  DeploymentProviderPolicy,
  DeploymentProviderProvisioningPolicy,
  DeploymentProviderStrategyInput,
  DeploymentProviderTargetPolicyInput,
  DeploymentProviderTargetPolicyResult,
  DeploymentProviderConnectionScopeInput,
  DeploymentProviderLogEntry,
} from '../../../domain/deployment-provider.policy';
import type { DeploymentProvisioningTarget } from '../../../core/deployment-provisioning.contract';
import type { DeploymentStrategy } from '../../../core/deployments.types';
import { RenderCostPolicyService } from './render-cost-policy.service';
import {
  RENDER_SERVICE_BRANCHES,
  renderBranchFor,
  renderImageUrl,
  type RenderServiceBranch,
} from './render-conventions';

/** Render owns all Render-shaped strategy and target compatibility decisions. */
@Injectable()
export class RenderDeploymentPolicy implements DeploymentProviderPolicy {
  readonly providerId = 'render';
  readonly managedQuota = {
    quotaCode: 'managed_render_services',
    fleetCapConfigKey: 'renderManagedFleetMax',
    providerLabel: 'Render',
    freeLimit: 1,
    proLimit: 10,
  };
  readonly provisioning: DeploymentProviderProvisioningPolicy = {
    resolveDefaultCreateTarget: ({ serviceName, repoName, servicePath }) => {
      const base = (serviceName || repoName || 'backend')
        .trim()
        .toLowerCase()
        .replaceAll(/[^a-z0-9._-]+/g, '-')
        .replaceAll(/^-+|-+$/g, '');
      const rootDirectory = servicePath?.trim() || '.';
      return {
        slot: 'backend',
        provider: this.providerId,
        ownershipMode: 'flowci_managed',
        projectName: `${base || 'backend'}-uat`,
        branchName: 'uat',
        rootDirectory,
        buildCommand: 'npm ci && npm run build',
        startCommand: 'npm run start:prod',
        renderDeployMethod: 'managed_image',
        renderServiceType: 'web_service',
        renderRuntime: 'docker',
        renderInstanceType: 'free',
        renderRegion: 'singapore',
        dockerContext: rootDirectory,
        dockerfilePath: 'Dockerfile',
        env: [],
      };
    },
    resolveDefaultTargetRole: () => 'backend',
    resolveCrossLinkLane: ({ renderEnvironmentName }) =>
      renderEnvironmentName === 'production' ? 'production' : 'preview',
    resolvePublicUrl: ({ providerProjectName, providerMetadata }) => {
      const metadataUrl = stringValue(providerMetadata['renderServiceUrl']);
      return (
        metadataUrl ||
        (providerProjectName
          ? `https://${providerProjectName}.onrender.com`
          : null)
      );
    },
    normalizeTarget: (target) => {
      if (target.branchName !== 'test') return target;
      const projectName = renderProjectNameForBranch(target, 'uat');
      return {
        ...target,
        branchName: 'uat',
        ...(projectName ? { projectName } : {}),
        renderEnvironmentName: 'uat',
      };
    },
    expandTargets: ({ target, allTargets }) => {
      if (!shouldFanOutRenderTarget(target, allTargets)) return [target];
      return RENDER_SERVICE_BRANCHES.map((branchName) => {
        const projectName = renderProjectNameForBranch(target, branchName);
        return {
          ...target,
          branchName,
          ...(projectName ? { projectName } : {}),
          renderEnvironmentName:
            branchName === 'main' ? 'production' : branchName,
        };
      });
    },
    defaultImageUrl: ({ repoFullName, target }) => {
      if (
        target.ownershipMode !== 'flowci_managed' ||
        target.renderDeployMethod === 'native_git' ||
        target.renderDeployMethod === 'existing_service'
      ) {
        return null;
      }
      return renderImageUrl({
        repoFullName,
        slot: target.slot,
        branchName: renderBranchOf(target),
        projectName: target.projectName,
      });
    },
  };

  constructor(private readonly costPolicy: RenderCostPolicyService) {}

  resolveStrategy(input: DeploymentProviderStrategyInput): DeploymentStrategy {
    const deployMethod = input.renderDeployMethod;
    if (
      input.action === 'register_existing' ||
      deployMethod === 'existing_service'
    ) {
      return 'render_existing_service';
    }
    if (
      input.ownershipMode === 'flowci_managed' ||
      deployMethod === 'byo_image'
    ) {
      return 'render_image_pushed';
    }
    return 'render_git_connected';
  }

  resolveTarget(
    input: DeploymentProviderTargetPolicyInput,
  ): DeploymentProviderTargetPolicyResult {
    const defaults = this.costPolicy.resolveDefaults({
      ownershipMode: input.ownershipMode,
      serviceType: input.renderServiceType,
      instanceType: input.renderInstanceType,
      region: input.renderRegion,
    });
    const rootDirectory = input.rootDirectory?.trim() || '.';
    const dockerContext =
      input.dockerContext?.trim() ||
      (rootDirectory === '.' ? '.' : rootDirectory);
    const renderEnvironmentName =
      input.renderEnvironmentName ??
      this.environmentFromBranch(input.branchName);
    const renderRuntime = input.renderRuntime ?? 'node';
    const dockerfilePath = input.dockerfilePath?.trim() || 'Dockerfile';
    const deploymentStrategy = this.resolveStrategy(input);

    return {
      storage: {
        renderServiceType: defaults.serviceType,
        renderRuntime,
        renderInstanceType: defaults.instanceType,
        renderRegion: defaults.region,
        renderEnvironmentName,
        dockerContext,
        dockerfilePath,
      },
      providerInput: {
        renderServiceType: defaults.serviceType,
        renderRuntime,
        renderInstanceType: defaults.instanceType,
        renderRegion: defaults.region,
        renderEnvironmentName,
        dockerContext,
        dockerfilePath,
      },
      providerMetadata: {
        deploymentStrategy,
        renderServiceType: defaults.serviceType,
        renderRuntime,
        renderInstanceType: defaults.instanceType,
        renderRegion: defaults.region,
        renderEnvironmentName,
        dockerContext,
        dockerfilePath,
      },
    };
  }

  resolveConnectionScope(
    _input: DeploymentProviderConnectionScopeInput,
  ): Record<string, unknown> {
    void _input;
    return {};
  }

  resolveOperationInput(input: {
    providerMetadata: Record<string, unknown>;
  }): Record<string, unknown> {
    const ownerId =
      stringValue(input.providerMetadata['renderOwnerId']) ||
      stringValue(input.providerMetadata['ownerId']);
    return ownerId ? { renderOwnerId: ownerId } : {};
  }

  resolveMockLogs(input: {
    providerProjectName: string | null;
    now: Date;
  }): readonly DeploymentProviderLogEntry[] {
    const dateStr = input.now.toLocaleDateString('en-US');
    const offsetDate = (secondsAgo: number) =>
      new Date(input.now.getTime() - secondsAgo * 1000).toISOString();

    return [
      {
        timestamp: offsetDate(90),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:40 AM     LOG [RouterExplorer] Mapped {/api/v1/capabilities, GET} route +1ms`,
        level: 'info',
      },
      {
        timestamp: offsetDate(88),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:40 AM     LOG [NestApplication] Nest application successfully started +402ms`,
        level: 'info',
      },
      {
        timestamp: offsetDate(86),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:40 AM     LOG [Bootstrap] Application running on 0.0.0.0:10000`,
        level: 'info',
      },
      {
        timestamp: offsetDate(75),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:41 AM    WARN [AllExceptionsFilter] HTTP 404 on HEAD /: Cannot HEAD /`,
        level: 'warn',
      },
      {
        timestamp: offsetDate(65),
        message: '==> Your service is live 🚀',
        level: 'system',
      },
      {
        timestamp: offsetDate(64),
        message: `==> Available at your primary URL https://${input.providerProjectName || 'flowci-be-test'}.onrender.com`,
        level: 'system',
      },
      {
        timestamp: offsetDate(60),
        message: '==> //////////////////////////////////////////////////////',
        level: 'system',
      },
      {
        timestamp: offsetDate(30),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:13:27 AM    WARN [CatalogService] Could not fetch central-workflow tags from GitHub; falling back to the default ref only; GitHub tags request failed with status 403`,
        level: 'warn',
      },
    ];
  }

  resolveManagedToken(input: {
    managedConfig: Record<string, unknown>;
  }): string {
    const token = stringValue(input.managedConfig['renderToken']);
    if (!token) {
      throw new BadRequestException(
        'ALPHACI-managed render token is not configured',
      );
    }
    return token;
  }

  private environmentFromBranch(
    branchName: string,
  ): 'dev' | 'uat' | 'production' {
    const branch = branchName.trim();
    if (branch === 'main') return 'production';
    if (branch === 'uat' || branch === 'production') {
      return branch;
    }
    return 'dev';
  }
}

/*
 * The branch this target's Render resources are named after.
 *
 * Delegates rather than testing for 'main': an earlier version returned the
 * first branch in the set for everything else, which was correct only while
 * that set was ['uat', 'main']. Adding 'dev' silently pointed every uat target
 * at the dev image.
 */
function renderBranchOf(
  target: DeploymentProvisioningTarget,
): RenderServiceBranch {
  return renderBranchFor(target.branchName);
}

function renderProjectNameForBranch(
  target: DeploymentProvisioningTarget,
  branchName: RenderServiceBranch,
): string | undefined {
  const raw = target.projectName?.trim();
  if (!raw) return undefined;
  const base = raw.replace(/-(test|uat|main|production)$/i, '');
  return `${base}-${branchName}`;
}

function shouldFanOutRenderTarget(
  target: DeploymentProvisioningTarget,
  allTargets: readonly DeploymentProvisioningTarget[],
): boolean {
  // An environment's target is exactly one service; the environment, not a
  // fixed branch list, decides where it deploys.
  if (target.environmentId) return false;
  if (
    target.ownershipMode !== 'flowci_managed' ||
    target.renderDeployMethod === 'existing_service'
  ) {
    return false;
  }

  const renderSiblings = allTargets.filter(
    (candidate) =>
      candidate.provider === target.provider &&
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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
