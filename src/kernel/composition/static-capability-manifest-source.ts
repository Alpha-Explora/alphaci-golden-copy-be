import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import type { CompositionSubject } from './capability-resolver.port.js';
import { applyClientPolicy } from './client-policy.js';
import {
  CLIENT_POLICY_SOURCE,
  type ClientPolicySource,
} from './client-policy.port.js';
import { PACK_MANIFESTS } from './manifests.js';
import type { CapabilityManifest } from './capability-types.js';
import type { CapabilityManifestSource } from './capability-manifest-source.port.js';

@Injectable()
export class StaticCapabilityManifestSource implements CapabilityManifestSource {
  constructor(
    private readonly configService: ConfigService,
    @Inject(CLIENT_POLICY_SOURCE)
    private readonly clientPolicies: ClientPolicySource,
  ) {}

  deployment(): CapabilityManifest {
    return applyClientPolicy(
      this.configuredManifest(),
      this.clientPolicies.deployment(),
    );
  }

  for(subject: CompositionSubject): CapabilityManifest {
    // The static source has no tenant store yet, but retaining the explicit
    // subject argument keeps this seam compatible with a future hosted source.
    return applyClientPolicy(
      this.configuredManifest(),
      this.clientPolicies.for(subject),
    );
  }

  private configuredManifest(): CapabilityManifest {
    const config = this.configService.getOrThrow<AppConfig>('app');
    return PACK_MANIFESTS[config.composition.edition];
  }
}
