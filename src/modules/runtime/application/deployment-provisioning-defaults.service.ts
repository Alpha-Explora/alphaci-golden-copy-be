import { Injectable } from '@nestjs/common';

import { DEFAULT_BACKEND_PROVIDER_ID } from '../core/deployment-provider.defaults';
import { DeploymentProviderPolicyRegistry } from '../core/deployment-provider.policy';
import type { DeploymentProvisioningTarget } from '../core/deployment-provisioning.contract';
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
    serviceName: string;
    repoName: string;
    servicePath?: string | undefined;
  }): DeploymentProvisioningTarget {
    const policy = this.providerPolicies.get(DEFAULT_BACKEND_PROVIDER_ID);
    if (!policy.provisioning?.resolveDefaultCreateTarget) {
      throw new Error(
        `Default deployment provider policy does not define a create target: ${DEFAULT_BACKEND_PROVIDER_ID}`,
      );
    }

    return policy.provisioning.resolveDefaultCreateTarget(input);
  }
}
