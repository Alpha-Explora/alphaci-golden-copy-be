import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { RenderCostPolicyService } from './render-cost-policy.service';

describe('RenderCostPolicyService', () => {
  const makeConfigService = (overrides = {}) =>
    ({
      getOrThrow: jest.fn().mockReturnValue({
        envProvisioning: {
          flowciManaged: {
            renderDefaultInstanceType: 'free',
            renderDefaultRegion: 'singapore',
            renderAllowedInstanceTypes: ['free'],
            renderAllowPaidManaged: false,
            ...overrides,
          },
        },
      }),
    }) as unknown as ConfigService;

  it('resolves managed Render defaults from config', () => {
    const service = new RenderCostPolicyService(makeConfigService());

    expect(
      service.resolveDefaults({
        ownershipMode: 'flowci_managed',
      }),
    ).toEqual({
      serviceType: 'web_service',
      instanceType: 'free',
      region: 'singapore',
    });
  });

  it('uses trimmed explicit free values before config defaults', () => {
    const service = new RenderCostPolicyService(makeConfigService());

    expect(
      service.resolveDefaults({
        ownershipMode: 'byo',
        serviceType: 'web_service',
        instanceType: ' free ',
        region: ' oregon ',
      }),
    ).toEqual({
      serviceType: 'web_service',
      instanceType: 'free',
      region: 'oregon',
    });
  });

  it('rejects Render instance types outside the free tier', () => {
    const service = new RenderCostPolicyService(makeConfigService());

    expect(() => service.assertAllowed('web_service', 'starter')).toThrow(
      BadRequestException,
    );
  });

  it('rejects free non-web Render service types', () => {
    const service = new RenderCostPolicyService(makeConfigService());

    expect(() => service.assertAllowed('background_worker', 'free')).toThrow(
      BadRequestException,
    );
  });

  it('rejects managed paid provisioning when disabled', () => {
    const service = new RenderCostPolicyService(
      makeConfigService({ renderAllowedInstanceTypes: ['starter'] }),
    );

    expect(() =>
      service.assertManagedAllowed('web_service', 'starter'),
    ).toThrow(BadRequestException);
  });
});
