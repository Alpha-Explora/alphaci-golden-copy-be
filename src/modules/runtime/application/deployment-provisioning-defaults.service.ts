import { Injectable } from '@nestjs/common';

import {
  DEFAULT_BACKEND_PROVIDER_ID,
  DEFAULT_FRONTEND_PROVIDER_ID,
} from '../core/deployment-provider.defaults';
import { DeploymentProviderPolicyRegistry } from '../domain/deployment-provider.policy';
import type { DeploymentProvisioningTarget } from '../core/deployment-provisioning.contract';
import type { DeploymentDefaultRole } from '#kernel/ports/deployment-runtime.port';
import type { DeploymentProvisioningDefaultsPort } from '../core/deployment-provisioning.defaults';

/**
 * Runtime-owned product default resolution.  The caller only sees a
 * provider-neutral port; the provider policy owns the concrete target shape.
 */
@Injectable()
export class DeploymentProvisioningDefaultsService implements DeploymentProvisioningDefaultsPort {
  constructor(
    private readonly providerPolicies: DeploymentProviderPolicyRegistry,
  ) {}

  resolveDefaultCreateTarget(input: {
    role: DeploymentDefaultRole;
    serviceName: string;
    repoName: string;
    servicePath?: string | undefined;
  }): DeploymentProvisioningTarget | undefined {
    const providerId =
      input.role === 'frontend'
        ? DEFAULT_FRONTEND_PROVIDER_ID
        : DEFAULT_BACKEND_PROVIDER_ID;
    const policy = this.providerPolicies.get(providerId);

    // Undefined rather than a throw: a provider that declares no create target
    // means the product has no default hosting for that role, which is a
    // configuration answer the caller can act on. Throwing here would fail
    // project creation outright over a missing convenience.
    return policy.provisioning?.resolveDefaultCreateTarget?.({
      serviceName: input.serviceName,
      repoName: input.repoName,
      ...(input.servicePath === undefined
        ? {}
        : { servicePath: input.servicePath }),
    });
  }
}
