import { BadRequestException, Injectable } from '@nestjs/common';

import type {
  DeploymentProviderConnectionScopeInput,
  DeploymentProviderPolicy,
  DeploymentProviderProvisioningPolicy,
  DeploymentProviderStrategyInput,
  DeploymentProviderTargetPolicyInput,
  DeploymentProviderTargetPolicyResult,
  DeploymentProviderLogEntry,
} from '../../../core/deployment-provider.policy';
import type { DeploymentProvisioningTarget } from '../../../core/deployment-provisioning.contract';
import type { DeploymentStrategy } from '../../../core/deployments.types';

/** Vercel owns team scope and its CI-pushed deployment strategy. */
@Injectable()
export class VercelDeploymentPolicy implements DeploymentProviderPolicy {
  readonly providerId = 'vercel';
  readonly managedQuota = {
    quotaCode: 'managed_vercel_projects',
    fleetCapConfigKey: 'vercelManagedFleetMax',
    providerLabel: 'Vercel',
    freeLimit: 1,
    proLimit: 10,
  };
  readonly provisioning: DeploymentProviderProvisioningPolicy = {
    resolveDefaultTargetRole: () => 'frontend',
    resolveCrossLinkLane: () => null,
    resolvePublicUrl: ({
      providerProjectName,
      providerMetadata,
      branchName,
      lane,
    }) => {
      if (!providerProjectName) return null;
      const productionUrl = `https://${providerProjectName}.vercel.app`;
      if (lane === 'production') return productionUrl;
      const teamSlug = stringValue(providerMetadata['vercelTeamSlug']);
      const branch = branchName?.trim();
      return teamSlug && branch
        ? `https://${providerProjectName}-git-${vercelBranchSlug(branch)}-${teamSlug}.vercel.app`
        : productionUrl;
    },
    normalizeTarget: (target) => {
      if (target.branchName !== 'test') return target;
      const projectName = vercelProjectNameForBranch(target, 'uat');
      return {
        ...target,
        branchName: 'uat',
        ...(projectName ? { projectName } : {}),
      };
    },
    expandTargets: ({ target }) => [target],
    defaultImageUrl: () => null,
  };

  resolveStrategy(input: DeploymentProviderStrategyInput): DeploymentStrategy {
    void input;
    return 'vercel_ci_pushed';
  }

  resolveTarget(
    input: DeploymentProviderTargetPolicyInput,
  ): DeploymentProviderTargetPolicyResult {
    return {
      storage: {},
      providerInput: this.resolveConnectionScope({
        ownershipMode: input.ownershipMode,
        connectionMetadata: input.connectionMetadata,
        managedConfig: input.managedConfig,
      }),
      providerMetadata: {},
    };
  }

  resolveConnectionScope(
    input: DeploymentProviderConnectionScopeInput,
  ): Record<string, unknown> {
    if (input.ownershipMode === 'flowci_managed') {
      const teamId = stringValue(input.managedConfig['vercelTeamId']);
      const teamSlug = stringValue(input.managedConfig['vercelTeamSlug']);
      if (!teamId) {
        throw new BadRequestException(
          'ALPHACI_VERCEL_TEAM_ID is required for ALPHACI-managed Vercel deployment targets',
        );
      }
      return {
        vercelOrgId: teamId,
        vercelTeamId: teamId,
        ...(teamSlug ? { vercelTeamSlug: teamSlug } : {}),
      };
    }

    const teamId = stringValue(input.connectionMetadata['teamId']);
    const teamSlug = stringValue(input.connectionMetadata['teamSlug']);
    const orgId = stringValue(input.connectionMetadata['orgId']);
    if (!orgId && !teamId) {
      throw new BadRequestException(
        'Vercel provider connection is missing org metadata. Reconnect the Vercel account before provisioning deployment targets.',
      );
    }

    return {
      vercelOrgId: orgId || teamId,
      ...(teamId ? { vercelTeamId: teamId } : {}),
      ...(teamSlug ? { vercelTeamSlug: teamSlug } : {}),
    };
  }

  resolveOperationInput(input: {
    providerMetadata: Record<string, unknown>;
  }): Record<string, unknown> {
    const teamId = stringValue(input.providerMetadata['vercelTeamId']);
    const teamSlug = stringValue(input.providerMetadata['vercelTeamSlug']);
    return {
      ...(teamId ? { vercelTeamId: teamId } : {}),
      ...(teamSlug ? { vercelTeamSlug: teamSlug } : {}),
    };
  }

  resolveMockLogs(input: {
    providerProjectName: string | null;
    now: Date;
  }): readonly DeploymentProviderLogEntry[] {
    const offsetDate = (secondsAgo: number) =>
      new Date(input.now.getTime() - secondsAgo * 1000).toISOString();

    return [
      {
        timestamp: offsetDate(70),
        message:
          ' ready   - started server on 0.0.0.0:3000, url: http://localhost:3000',
        level: 'info',
      },
      {
        timestamp: offsetDate(68),
        message: ' info    - Loaded env from /app/.env',
        level: 'info',
      },
      {
        timestamp: offsetDate(60),
        message:
          ' event   - compiled client and server successfully in 835ms (192 modules)',
        level: 'info',
      },
      {
        timestamp: offsetDate(50),
        message: ' info    - [request] GET / 200 in 89ms',
        level: 'info',
      },
      {
        timestamp: offsetDate(40),
        message: ' info    - [request] GET /api/capabilities 200 in 12ms',
        level: 'info',
      },
      {
        timestamp: offsetDate(30),
        message:
          ' warn    - [warning] Large page data detected in /projects/[projectId] (120kb)',
        level: 'warn',
      },
      {
        timestamp: offsetDate(15),
        message:
          ' error   - [problem] Failed to proxy socket connection: connection timeout at /api/ws',
        level: 'error',
      },
    ];
  }

  resolveManagedToken(input: {
    managedConfig: Record<string, unknown>;
  }): string {
    const token = stringValue(input.managedConfig['vercelToken']);
    if (!token) {
      throw new BadRequestException(
        'ALPHACI-managed vercel token is not configured',
      );
    }
    return token;
  }
}

function vercelProjectNameForBranch(
  target: DeploymentProvisioningTarget,
  branchName: 'uat',
): string | undefined {
  const raw = target.projectName?.trim();
  if (!raw) return undefined;
  const base = raw.replace(/-(test|uat|main|production)$/i, '');
  return `${base}-${branchName}`;
}

function vercelBranchSlug(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
