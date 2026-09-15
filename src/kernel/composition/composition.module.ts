import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import { CAPABILITY_MANIFEST_SOURCE } from './capability-manifest-source.port.js';
import {
  CAPABILITY_RESOLVER,
  DEPLOYMENT_CAPABILITY_RESOLVER,
} from './capability-resolver.port.js';
import { CapabilityResolverService } from './capability-resolver.service.js';
import { CapabilityGuard } from './capability.guard.js';
import {
  CLIENT_POLICY_PACK_LOADER,
  type ClientPolicyPackLoader,
} from './client-policy-pack.port.js';
import {
  CLIENT_POLICY_SOURCE,
  type ClientPolicySource,
} from './client-policy.port.js';
import { loadClientPolicyPack } from './client-policy-pack-loader.js';
import { DeploymentCapabilityResolverService } from './deployment-capability-resolver.service.js';
import { StaticCapabilityManifestSource } from './static-capability-manifest-source.js';

const EMPTY_CLIENT_POLICY_SOURCE: ClientPolicySource = {
  deployment: () => null,
  for: () => null,
};

@Global()
@Module({
  providers: [
    CapabilityGuard,
    StaticCapabilityManifestSource,
    CapabilityResolverService,
    DeploymentCapabilityResolverService,
    {
      provide: CLIENT_POLICY_SOURCE,
      inject: [ConfigService, CLIENT_POLICY_PACK_LOADER],
      useFactory: async (
        configService: ConfigService,
        loadPack: ClientPolicyPackLoader,
      ) => {
        const composition =
          configService.getOrThrow<AppConfig>('app').composition;
        const pack = await loadPack(composition.profile);
        return pack?.createSource(composition) ?? EMPTY_CLIENT_POLICY_SOURCE;
      },
    },
    {
      provide: CLIENT_POLICY_PACK_LOADER,
      useValue: loadClientPolicyPack,
    },
    {
      provide: CAPABILITY_MANIFEST_SOURCE,
      useExisting: StaticCapabilityManifestSource,
    },
    {
      provide: CAPABILITY_RESOLVER,
      useExisting: CapabilityResolverService,
    },
    {
      provide: DEPLOYMENT_CAPABILITY_RESOLVER,
      useExisting: DeploymentCapabilityResolverService,
    },
  ],
  exports: [
    CAPABILITY_RESOLVER,
    DEPLOYMENT_CAPABILITY_RESOLVER,
    CapabilityGuard,
    CLIENT_POLICY_SOURCE,
  ],
})
export class CompositionModule {}
