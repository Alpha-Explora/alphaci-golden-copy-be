import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import type { CompositionSubject } from './capability-resolver.port.js';
import { PACK_MANIFESTS } from './manifests.js';
import type { CapabilityManifest } from './capability-types.js';
import type { CapabilityManifestSource } from './capability-manifest-source.port.js';

@Injectable()
export class StaticCapabilityManifestSource implements CapabilityManifestSource {
  constructor(private readonly configService: ConfigService) {}

  deployment(): CapabilityManifest {
    return this.configuredManifest();
  }

  for(subject: CompositionSubject): CapabilityManifest {
    // The static source has no tenant store yet, but retaining the explicit
    // subject argument keeps this seam compatible with a future hosted source.
    void subject;
    return this.configuredManifest();
  }

  private configuredManifest(): CapabilityManifest {
    const config = this.configService.getOrThrow<AppConfig>('app');
    return PACK_MANIFESTS[config.composition.edition];
  }
}
