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
import { CLIENT_POLICY_SOURCE } from './client-policy.port.js';
import { createClientPolicySource } from './client-policy-source.js';
import { DeploymentCapabilityResolverService } from './deployment-capability-resolver.service.js';
import { StaticCapabilityManifestSource } from './static-capability-manifest-source.js';

@Global()
@Module({
  providers: [
    CapabilityGuard,
    StaticCapabilityManifestSource,
    CapabilityResolverService,
    DeploymentCapabilityResolverService,
    {
      provide: CLIENT_POLICY_SOURCE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createClientPolicySource(
          configService.getOrThrow<AppConfig>('app').composition,
        ),
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
