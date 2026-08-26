import { Test } from '@nestjs/testing';

import { DeploymentProvidersController } from './deployment-providers.controller';
import { RuntimeCoreModule } from './runtime-core.module';

describe('RuntimeCoreModule', () => {
  it('provides the discovery controller with an empty registry before providers register', async () => {
    const module = await Test.createTestingModule({
      imports: [RuntimeCoreModule],
    }).compile();
    const controller = module.get(DeploymentProvidersController);

    expect(controller.list()).toEqual({ providers: [] });
  });
});
