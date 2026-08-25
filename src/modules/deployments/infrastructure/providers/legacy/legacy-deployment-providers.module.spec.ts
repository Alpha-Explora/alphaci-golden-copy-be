import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { DeploymentsCoreModule } from '../../../core/deployments-core.module';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { LegacyDeploymentProvidersModule } from './legacy-deployment-providers.module';

describe('LegacyDeploymentProvidersModule', () => {
  it('registers the enabled Render and Vercel compatibility providers', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              app: {
                envProvisioning: { enabled: true },
              },
            }),
          ],
        }),
        DeploymentsCoreModule,
        LegacyDeploymentProvidersModule,
      ],
    }).compile();

    await module.init();

    const registry = module.get(DeploymentProviderRegistry);
    expect(registry.list().map((provider) => provider.id)).toEqual([
      'render',
      'vercel',
    ]);

    await module.close();
  });
});
