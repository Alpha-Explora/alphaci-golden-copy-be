import { Inject, Injectable, Scope } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import {
  CAPABILITY_MANIFEST_SOURCE,
  type CapabilityManifestSource,
} from './capability-manifest-source.port.js';
import {
  type CapabilityResolverPort,
  type CompositionSubject,
} from './capability-resolver.port.js';
import type { CapabilitySet } from './capability-types.js';
import { resolveCapabilities } from './capability-resolver.js';

@Injectable({ scope: Scope.REQUEST })
export class CapabilityResolverService implements CapabilityResolverPort {
  constructor(
    @Inject(CAPABILITY_MANIFEST_SOURCE)
    private readonly manifestSource: CapabilityManifestSource,
    private readonly configService: ConfigService,
  ) {}

  deployment(): CapabilitySet {
    return resolveCapabilities({
      manifest: this.manifestSource.deployment(),
      config: this.configService.getOrThrow<AppConfig>('app'),
    });
  }

  for(subject: CompositionSubject): CapabilitySet {
    return resolveCapabilities({
      manifest: this.manifestSource.for(subject),
      config: this.configService.getOrThrow<AppConfig>('app'),
    });
  }
}
