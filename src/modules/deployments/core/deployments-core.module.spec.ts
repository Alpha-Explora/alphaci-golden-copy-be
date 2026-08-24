import { Test } from '@nestjs/testing';

import { DeploymentProvidersController } from './deployment-providers.controller';
import { DeploymentsCoreModule } from './deployments-core.module';

describe('DeploymentsCoreModule', () => {
  it('provides the discovery controller with an empty registry before providers register', async () => {
    const module = await Test.createTestingModule({
      imports: [DeploymentsCoreModule],
    }).compile();
    const controller = module.get(DeploymentProvidersController);

    expect(controller.list()).toEqual({ providers: [] });
  });
});
