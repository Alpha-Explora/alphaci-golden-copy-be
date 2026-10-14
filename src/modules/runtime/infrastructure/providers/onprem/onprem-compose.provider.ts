import { Injectable, type OnModuleInit } from '@nestjs/common';

import type {
  DeploymentProvider,
  ProviderCapabilities,
  ProviderFormSchema,
} from '../../../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';

export const ONPREM_COMPOSE_PROVIDER_ID = 'onprem-compose';

/**
 * A customer's own host, running Docker Compose, that pulls its environment's
 * signed releases. AlphaCI never connects to it and holds none of its
 * credentials, so the capabilities say so: connectivity is indirect (the host
 * calls in) and credential custody is external (the customer keeps them).
 */
const capabilities: ProviderCapabilities = {
  envVars: false,
  logs: false,
  deployHistory: false,
  teardown: false,
  managedMode: false,
  liveStatus: false,
  connectivity: 'indirect',
  enumerable: false,
  credentialCustody: 'external',
  envProvisioning: false,
  previewDeployments: false,
};

const configSchema: ProviderFormSchema = {
  fields: [
    { key: 'providerProjectName', label: 'Host label', required: false },
  ],
};

@Injectable()
export class OnpremComposeDeploymentProvider
  implements DeploymentProvider, OnModuleInit
{
  readonly id = ONPREM_COMPOSE_PROVIDER_ID;
  readonly label = 'On-prem host (Docker Compose)';
  readonly supportedSlots = ['backend', 'frontend', 'standalone'];
  readonly capabilities = capabilities;
  readonly configSchema = configSchema;
  readonly credentialSchema: ProviderFormSchema = { fields: [] };

  constructor(
    private readonly enabled: boolean,
    private readonly registry: DeploymentProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  isEnabled(): { enabled: boolean; reason?: string } {
    return this.enabled
      ? { enabled: true }
      : {
          enabled: false,
          reason: 'On-prem hosts are not enabled in this deployment',
        };
  }

  validateConfig(): void {
    // The host label is optional and free text; nothing else is configured here.
  }
}
