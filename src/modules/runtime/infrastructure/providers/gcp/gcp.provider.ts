import { Injectable, type OnModuleInit } from '@nestjs/common';

import type {
  DeploymentProvider,
  ProviderCapabilities,
  ProviderFormSchema,
} from '../../../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';

export interface GcpDeploymentProviderConfig {
  enabled: boolean;
  projectId: string;
  region: string;
  artifactRegistryRepository: string;
}

const capabilities: ProviderCapabilities = {
  envVars: true,
  logs: true,
  deployHistory: true,
  teardown: true,
  managedMode: true,
  liveStatus: true,
  connectivity: 'direct',
  enumerable: false,
  credentialCustody: 'platform',
  envProvisioning: false,
  previewDeployments: false,
};

const configSchema: ProviderFormSchema = {
  fields: [
    { key: 'projectId', label: 'GCP project ID', required: true },
    { key: 'region', label: 'GCP region', required: true },
    { key: 'service', label: 'Cloud Run service', required: true },
  ],
};

@Injectable()
export class GcpDeploymentProvider implements DeploymentProvider, OnModuleInit {
  readonly id = 'gcp';
  readonly label = 'Google Cloud Platform';
  readonly supportedSlots = ['backend', 'frontend', 'standalone'];
  readonly capabilities = capabilities;
  readonly configSchema = configSchema;
  readonly credentialSchema: ProviderFormSchema = { fields: [] };

  constructor(
    private readonly config: GcpDeploymentProviderConfig,
    private readonly registry: DeploymentProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  isEnabled(): { enabled: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { enabled: false, reason: 'GCP deployments are disabled' };
    }

    if (
      !this.config.projectId.trim() ||
      !this.config.region.trim() ||
      !this.config.artifactRegistryRepository.trim()
    ) {
      return {
        enabled: false,
        reason: 'GCP deployment configuration is incomplete',
      };
    }

    return { enabled: true };
  }

  validateConfig(config: Record<string, unknown>): void {
    const missing = ['projectId', 'region', 'service'].filter(
      (key) => typeof config[key] !== 'string' || !config[key].trim(),
    );

    if (missing.length > 0) {
      throw new Error(
        `GCP deployment configuration requires ${missing.join(' and ')}`,
      );
    }
  }
}
