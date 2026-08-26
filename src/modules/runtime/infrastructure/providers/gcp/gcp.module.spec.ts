import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { RuntimeCoreModule } from '../../../core/runtime-core.module';
import type { DeploymentProvider } from '../../../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import { FakeGcpRuntimeAdapter } from './fake-gcp-runtime.adapter';
import { GCP_RUNTIME_ADAPTER } from './gcp-runtime.port';
import { GcpDeploymentModule } from './gcp.module';
import { GcpProvisioningExecutor } from './gcp-provisioning.executor';
import { GcpProvisioningService } from './gcp-provisioning.service';

describe('GcpDeploymentModule', () => {
  it('registers an enabled GCP provider from application configuration', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              app: {
                supabase: { dbUrl: '', dbCaCert: '' },
                gcpDeployments: {
                  enabled: true,
                  sharedProjectId: 'alpha-runtime',
                  region: 'asia-southeast1',
                  artifactRegistryRepository: 'alphaci-images',
                  workloadIdentityProvider: '',
                  deployerServiceAccount: '',
                  dedicatedProjectsEnabled: false,
                },
              },
            }),
          ],
        }),
        RuntimeCoreModule,
        GcpDeploymentModule,
      ],
    }).compile();
    await module.init();

    const registry = module.get<DeploymentProviderRegistry<DeploymentProvider>>(
      DeploymentProviderRegistry,
    );

    expect(registry.get('gcp').isEnabled()).toEqual({ enabled: true });
    expect(module.get(GcpProvisioningService)).toBeInstanceOf(
      GcpProvisioningService,
    );
    expect(module.get(GcpProvisioningExecutor)).toBeInstanceOf(
      GcpProvisioningExecutor,
    );
  });

  it('uses the non-networking fake adapter when GCP deployments are disabled', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              app: {
                supabase: { dbUrl: '', dbCaCert: '' },
                gcpDeployments: {
                  enabled: false,
                  sharedProjectId: '',
                  region: 'asia-southeast1',
                  artifactRegistryRepository: '',
                  workloadIdentityProvider: '',
                  deployerServiceAccount: '',
                  dedicatedProjectsEnabled: false,
                },
              },
            }),
          ],
        }),
        RuntimeCoreModule,
        GcpDeploymentModule,
      ],
    }).compile();

    expect(module.get(GCP_RUNTIME_ADAPTER)).toBeInstanceOf(
      FakeGcpRuntimeAdapter,
    );

    await module.close();
  });
});
