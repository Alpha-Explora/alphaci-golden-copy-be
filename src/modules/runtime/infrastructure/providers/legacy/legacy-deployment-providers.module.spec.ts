import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { RuntimeCoreModule } from '../../../core/runtime-core.module';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { WORKFLOW_FRAGMENTS } from '../../../core/workflow-fragment.contract';
import { RenderDeploymentProvider } from '../render/render-deployment.provider';
import { VercelDeploymentProvider } from '../vercel/vercel-deployment.provider';
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
        RuntimeCoreModule,
        LegacyDeploymentProvidersModule,
      ],
    }).compile();

    await module.init();

    const registry = module.get(DeploymentProviderRegistry);
    expect(registry.list().map((provider) => provider.id)).toEqual([
      'render',
      'vercel',
    ]);
    expect(registry.get('render')).toBeInstanceOf(RenderDeploymentProvider);
    expect(registry.get('vercel')).toBeInstanceOf(VercelDeploymentProvider);
    const fragments =
      module.get<Array<{ provider: string }>>(WORKFLOW_FRAGMENTS);
    expect(fragments.map((fragment) => fragment.provider)).toEqual([
      'render',
      'vercel',
    ]);

    await module.close();
  });
});
