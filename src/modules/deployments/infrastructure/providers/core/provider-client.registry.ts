import { Injectable } from '@nestjs/common';

import type { EnvProvider } from '../../../deployments.types';
import type { DeploymentProvider } from '../../../core/deployment-provider-runtime.contract';
import { RenderEnvClient } from '../render/render-env.client';
import { VercelEnvClient } from '../vercel/vercel-env.client';

@Injectable()
export class ProviderClientRegistry {
  constructor(
    private readonly renderClient: RenderEnvClient,
    private readonly vercelClient: VercelEnvClient,
  ) {}

  getClient(provider: EnvProvider): DeploymentProvider {
    if (provider === 'render') {
      return this.renderClient;
    }

    return this.vercelClient;
  }
}
