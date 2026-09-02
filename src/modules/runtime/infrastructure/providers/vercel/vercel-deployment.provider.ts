import { Injectable, type OnModuleInit } from '@nestjs/common';

import type {
  DeploymentProvider,
  DeploymentProviderConnectionPreparationInput,
  DeploymentProviderPresentation,
  ProviderFormSchema,
} from '../../../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import type { DeploymentProviderPolicy } from '../../../domain/deployment-provider.policy';
import {
  LEGACY_PROVIDER_CAPABILITIES,
  LEGACY_PROVIDER_CONFIG_SCHEMA,
  providerMetadataString,
  stringValue,
  type LegacyProviderConfig,
} from '../core/legacy-provider.shared';

const VERCEL_PRESENTATION: DeploymentProviderPresentation = {
  publicUrl: (target, lane = 'production') => {
    if (!target.providerProjectName) return null;
    const productionUrl = `https://${target.providerProjectName}.vercel.app`;
    if (lane === 'production') return productionUrl;

    const teamSlug = providerMetadataString(target, 'vercelTeamSlug');
    const branch = target.branchName?.trim() ?? '';
    return teamSlug && branch
      ? `https://${target.providerProjectName}-git-${branch
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')}-${teamSlug}.vercel.app`
      : productionUrl;
  },
  dashboardUrl: (target) => {
    const teamSlug = providerMetadataString(target, 'vercelTeamSlug');
    return teamSlug
      ? `https://vercel.com/${teamSlug}/${target.providerProjectName}`
      : `https://vercel.com/dashboard/project/${target.providerProjectId}`;
  },
  consoleUrl: (target) => {
    const teamSlug = providerMetadataString(target, 'vercelTeamSlug');
    return teamSlug
      ? `https://vercel.com/${teamSlug}/${target.providerProjectName}/deployments`
      : `https://vercel.com/dashboard/project/${target.providerProjectId}/deployments`;
  },
};

/** Runtime composition token for the Vercel provider descriptor. */
export const VERCEL_DEPLOYMENT_PROVIDER = Symbol('VercelDeploymentProvider');

/** Compatibility descriptor for Vercel's existing runtime adapter. */
@Injectable()
export class VercelDeploymentProvider
  implements DeploymentProvider, OnModuleInit
{
  readonly id = 'vercel';
  readonly label: string;
  readonly supportedSlots: readonly string[];
  readonly capabilities;
  readonly configSchema: ProviderFormSchema = LEGACY_PROVIDER_CONFIG_SCHEMA;
  readonly credentialSchema: ProviderFormSchema = { fields: [] };
  readonly policy: DeploymentProviderPolicy;
  readonly presentation = VERCEL_PRESENTATION;
  readonly slotViolationMessage = (): string =>
    `Vercel deployment targets are frontend-only. Choose the frontend slot for Vercel.`;

  constructor(
    private readonly config: LegacyProviderConfig,
    private readonly registry: DeploymentProviderRegistry,
    policy: DeploymentProviderPolicy,
  ) {
    this.label = config.label;
    this.supportedSlots = config.supportedSlots;
    this.capabilities = {
      ...LEGACY_PROVIDER_CAPABILITIES,
      previewDeployments: config.previewDeployments ?? false,
    };
    this.policy = policy;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  isEnabled(): { enabled: boolean; reason?: string } {
    return this.config.enabled
      ? { enabled: true }
      : {
          enabled: false,
          reason: `${this.label} provisioning is disabled`,
        };
  }

  validateConfig(config: Record<string, unknown>): void {
    if (
      typeof config.providerProjectId !== 'string' ||
      !config.providerProjectId.trim()
    ) {
      throw new Error('providerProjectId is required');
    }
  }

  async prepareConnection(
    input: DeploymentProviderConnectionPreparationInput,
  ): Promise<Record<string, unknown>> {
    const teamId = stringValue(input.config['vercelTeamId']);
    const teamSlug = stringValue(input.config['vercelTeamSlug']);
    if (teamSlug && !teamId) {
      throw new Error('vercelTeamId is required when connecting a Vercel team');
    }

    const team = teamId
      ? await input.client.validateTeamAccess?.(input.token, teamId)
      : undefined;
    if (teamId && !team) {
      throw new Error(
        'Vercel team validation is not supported by this provider client',
      );
    }

    const resolvedTeamId = team?.id ?? teamId;
    const resolvedTeamSlug = team?.slug ?? teamSlug;
    if (resolvedTeamId) {
      return {
        accountType: 'team',
        orgId: resolvedTeamId,
        teamId: resolvedTeamId,
        ...(resolvedTeamSlug ? { teamSlug: resolvedTeamSlug } : {}),
      };
    }

    return {
      accountType: 'user',
      orgId: input.account.metadata?.['orgId'] ?? input.account.id,
    };
  }
}
