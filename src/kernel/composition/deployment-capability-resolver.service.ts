import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import {
  CAPABILITY_MANIFEST_SOURCE,
  type CapabilityManifestSource,
} from './capability-manifest-source.port.js';
import type {
  CapabilityResolverPort,
  CompositionSubject,
} from './capability-resolver.port.js';
import type { CapabilitySet } from './capability-types.js';
import { resolveCapabilities } from './capability-resolver.js';

/**
 * Deployment-scoped resolver for background work that has no HTTP subject.
 *
 * The request-scoped resolver remains the boundary for controllers and guards.
 * This singleton keeps boot-time consumers such as the outbox relay from
 * becoming request-scoped merely because they need deployment composition.
 */
@Injectable()
export class DeploymentCapabilityResolverService implements CapabilityResolverPort {
  constructor(
    @Inject(CAPABILITY_MANIFEST_SOURCE)
    private readonly manifestSource: CapabilityManifestSource,
    private readonly configService: ConfigService,
  ) {}

  deployment(): CapabilitySet {
    return this.resolve(this.manifestSource.deployment());
  }

  for(_subject: CompositionSubject): CapabilitySet {
    return this.resolve(this.manifestSource.for(_subject));
  }

  private resolve(
    manifest: ReturnType<CapabilityManifestSource['deployment']>,
  ) {
    return resolveCapabilities({
      manifest,
      config: this.configService.getOrThrow<AppConfig>('app'),
    });
  }
}
