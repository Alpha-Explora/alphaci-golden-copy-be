import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { CLIENT_POLICY_SOURCE } from '#kernel/composition/client-policy.port';
import { CAPABILITY_RESOLVER } from '#kernel/composition/capability-resolver.port';
import { DEPLOYMENT_PROVIDER_CATALOG } from '#kernel/ports/deployment-provider-catalog.port';
import { CapabilitiesController } from './capabilities.controller';

describe('CapabilitiesController client composition projection', () => {
  it('projects only the selected deny-only Enterprise policy', async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue({
              composition: { edition: 'enterprise' },
              envProvisioning: { ownershipMode: 'flowci_managed' },
              hierarchy: { githubSyncMode: 'stub' },
            }),
          },
        },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: {
            deployment: () => new Set(['runtime.client-composition']),
          },
        },
        {
          provide: DEPLOYMENT_PROVIDER_CATALOG,
          useValue: { list: () => [] },
        },
        {
          provide: CLIENT_POLICY_SOURCE,
          useValue: {
            deployment: () => ({
              clientId: 'northwind',
              displayName: 'Northwind Industries',
              edition: 'enterprise',
              disabledCapabilities: ['runtime.preview-deployments'],
            }),
          },
        },
      ],
    }).compile();

    expect(
      module.get(CapabilitiesController).getCapabilities().clientComposition,
    ).toEqual({
      enabled: true,
      clientId: 'northwind',
      displayName: 'Northwind Industries',
      edition: 'enterprise',
      disabledCapabilities: ['runtime.preview-deployments'],
    });
  });
});
