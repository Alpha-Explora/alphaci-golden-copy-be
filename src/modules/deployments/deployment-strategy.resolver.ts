import { Injectable } from '@nestjs/common';

import type {
  DeploymentStrategy,
  EnvOwnershipMode,
  EnvProvider,
  RenderDeployMethod,
} from './deployments.types';

export interface ResolveDeploymentStrategyInput {
  provider: EnvProvider;
  ownershipMode: EnvOwnershipMode;
  action?: 'create' | 'register_existing';
  renderDeployMethod?: RenderDeployMethod | undefined;
}

@Injectable()
export class DeploymentStrategyResolver {
  resolve(input: ResolveDeploymentStrategyInput): DeploymentStrategy {
    if (input.provider === 'vercel') {
      return 'vercel_ci_pushed';
    }

    if (input.provider === 'render') {
      if (
        input.action === 'register_existing' ||
        input.renderDeployMethod === 'existing_service'
      ) {
        return 'render_existing_service';
      }

      if (input.ownershipMode === 'flowci_managed') {
        return 'render_image_pushed';
      }

      if (input.renderDeployMethod === 'byo_image') {
        return 'render_image_pushed';
      }

      return 'render_git_connected';
    }

    return 'provider_native';
  }
}
