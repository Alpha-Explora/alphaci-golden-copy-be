import type { DeploymentProvisioningTarget } from '../core/deployment-provisioning.contract';

import { toCreateDeploymentTargetDto } from './provision-for-project.mapping';

const baseTarget: DeploymentProvisioningTarget = {
  slot: 'backend',
  provider: 'render',
  ownershipMode: 'flowci_managed',
};

describe('toCreateDeploymentTargetDto', () => {
  it('defaults action to create and omits empty optional fields', () => {
    expect(
      toCreateDeploymentTargetDto({ ...baseTarget, projectName: '' }, null),
    ).toEqual({
      action: 'create',
      slot: 'backend',
      ownershipMode: 'flowci_managed',
      provider: 'render',
      branchName: 'uat',
    });
  });

  it('registers an existing Render service when no action is set', () => {
    expect(
      toCreateDeploymentTargetDto(
        { ...baseTarget, renderDeployMethod: 'existing_service' },
        null,
      ).action,
    ).toBe('register_existing');
  });

  it('keeps an explicit action over the Render deploy method', () => {
    expect(
      toCreateDeploymentTargetDto(
        {
          ...baseTarget,
          action: 'create',
          renderDeployMethod: 'existing_service',
        },
        null,
      ).action,
    ).toBe('create');
  });

  it('copies truthy optional fields and prefers the requested image URL', () => {
    expect(
      toCreateDeploymentTargetDto(
        {
          ...baseTarget,
          projectName: 'orders-api-uat',
          renderRuntime: 'python',
          imageUrl: 'ghcr.io/acme/app:requested',
          branchName: '  preview  ',
        },
        'ghcr.io/acme/app:default',
      ),
    ).toEqual({
      action: 'create',
      slot: 'backend',
      ownershipMode: 'flowci_managed',
      provider: 'render',
      branchName: 'preview',
      projectName: 'orders-api-uat',
      renderRuntime: 'python',
      imageUrl: 'ghcr.io/acme/app:requested',
    });
  });

  it('uses the managed default image when the request has none', () => {
    expect(
      toCreateDeploymentTargetDto(baseTarget, 'ghcr.io/acme/app:default'),
    ).toEqual({
      action: 'create',
      slot: 'backend',
      ownershipMode: 'flowci_managed',
      provider: 'render',
      branchName: 'uat',
      imageUrl: 'ghcr.io/acme/app:default',
    });
  });
});
