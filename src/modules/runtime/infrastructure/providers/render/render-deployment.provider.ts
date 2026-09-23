import { Injectable, type OnModuleInit } from '@nestjs/common';

import type {
  DeploymentProvider,
  DeploymentProviderPresentation,
  ProviderFormSchema,
} from '../../../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import type { DeploymentProviderPolicy } from '../../../domain/deployment-provider.policy';
import {
  LEGACY_PROVIDER_CAPABILITIES,
  LEGACY_PROVIDER_CONFIG_SCHEMA,
  providerMetadataString,
  type LegacyProviderConfig,
} from '../core/legacy-provider.shared';

const RENDER_PRESENTATION: DeploymentProviderPresentation = {
  publicUrl: (target) =>
    providerMetadataString(target, 'renderServiceUrl') ||
    (target.providerProjectName
      ? `https://${target.providerProjectName}.onrender.com`
      : null),
  dashboardUrl: (target) =>
    target.providerProjectId
      ? `https://dashboard.render.com/web/${target.providerProjectId}`
      : null,
  consoleUrl: (target) =>
    target.providerProjectId
      ? `https://dashboard.render.com/web/${target.providerProjectId}/logs`
      : null,
};

/** Runtime composition token for the Render provider descriptor. */
export const RENDER_DEPLOYMENT_PROVIDER = Symbol('RenderDeploymentProvider');

/** Compatibility descriptor for Render's existing runtime adapter. */
@Injectable()
export class RenderDeploymentProvider
  implements DeploymentProvider, OnModuleInit
{
  readonly id = 'render';
  readonly label: string;
  readonly supportedSlots: readonly string[];
  readonly capabilities;
  readonly configSchema: ProviderFormSchema = LEGACY_PROVIDER_CONFIG_SCHEMA;
  readonly credentialSchema: ProviderFormSchema = { fields: [] };
  readonly policy: DeploymentProviderPolicy;
  readonly presentation = RENDER_PRESENTATION;
  readonly slotViolationMessage = (): string =>
    `Render deployment targets are backend-only. Choose the backend slot for Render.`;

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
      // Render's /v1/logs accepts all four filters server-side (see
      // render-env.mapping.ts's buildRenderLogsQueryParams).
      logFilters: ['level', 'type', 'text', 'instance'] as const,
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

  prepareConnection(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
}
