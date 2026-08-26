import { Injectable } from '@nestjs/common';

import { type ProviderClientRegistryPort } from '../../../application/ports/provider-client-registry.port';
import type { RuntimeEnvProviderClient } from '../../../application/ports/runtime-env-provider.client';
import type { EnvProvider } from '../../../core/deployments.types';
import { RenderEnvClient } from '../render/render-env.client';
import { VercelEnvClient } from '../vercel/vercel-env.client';

@Injectable()
export class ProviderClientRegistry implements ProviderClientRegistryPort {
  constructor(
    private readonly renderClient: RenderEnvClient,
    private readonly vercelClient: VercelEnvClient,
  ) {}

  getClient(provider: EnvProvider): RuntimeEnvProviderClient {
    if (provider === 'render') {
      return this.renderClient;
    }

    return this.vercelClient;
  }
}
