import { Controller, Get } from '@nestjs/common';

import type { DeploymentProvider } from '../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';

@Controller('deployment-providers')
export class DeploymentProvidersController {
  constructor(
    private readonly providerRegistry: DeploymentProviderRegistry<DeploymentProvider>,
  ) {}

  @Get()
  list() {
    return {
      providers: this.providerRegistry.list().map((provider) => {
        const availability = provider.isEnabled();

        return {
          id: provider.id,
          label: provider.label,
          enabled: availability.enabled,
          ...(availability.reason ? { reason: availability.reason } : {}),
          supportedSlots: [...provider.supportedSlots],
          capabilities: provider.capabilities,
          configSchema: provider.configSchema,
          credentialSchema: provider.credentialSchema,
        };
      }),
    };
  }
}
