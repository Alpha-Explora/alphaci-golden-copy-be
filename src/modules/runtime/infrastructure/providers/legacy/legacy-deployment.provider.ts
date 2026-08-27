import { Injectable, type OnModuleInit } from '@nestjs/common';

import type {
  DeploymentProvider,
  ProviderCapabilities,
  ProviderFormSchema,
} from '../../../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';

export interface LegacyDeploymentProviderConfig {
  id: 'render' | 'vercel';
  label: string;
  enabled: boolean;
  supportedSlots: Array<'backend' | 'frontend' | 'standalone'>;
  previewDeployments?: boolean;
}

const LEGACY_CONFIG_SCHEMA: ProviderFormSchema = {
  fields: [
    {
      key: 'providerProjectId',
      label: 'Provider project or service ID',
      required: true,
    },
  ],
};

const LEGACY_CAPABILITIES: ProviderCapabilities = {
  envVars: true,
  logs: true,
  deployHistory: true,
  teardown: true,
  managedMode: true,
  liveStatus: true,
  connectivity: 'direct',
  enumerable: true,
  credentialCustody: 'platform',
  envProvisioning: true,
};

/**
 * Metadata adapter for the existing Render and Vercel provisioning flows.
 * It intentionally does not replace their established client/workflow code.
 */
@Injectable()
export class LegacyDeploymentProvider
  implements DeploymentProvider, OnModuleInit
{
  readonly id: 'render' | 'vercel';
  readonly label: string;
  readonly supportedSlots: Array<'backend' | 'frontend' | 'standalone'>;
  readonly capabilities: ProviderCapabilities;
  readonly configSchema = LEGACY_CONFIG_SCHEMA;
  readonly credentialSchema: ProviderFormSchema = { fields: [] };

  constructor(
    private readonly config: LegacyDeploymentProviderConfig,
    private readonly registry: DeploymentProviderRegistry,
  ) {
    this.id = config.id;
    this.label = config.label;
    this.supportedSlots = config.supportedSlots;
    this.capabilities = {
      ...LEGACY_CAPABILITIES,
      previewDeployments: config.previewDeployments ?? false,
    };
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
}
