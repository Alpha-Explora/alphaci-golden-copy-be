import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  PROVIDER_RELEASERS,
  type ProviderReleaser,
  type ProviderReleaserRegistryPort,
} from '../../../application/ports/provider-releaser.port';

/** Runtime composition registry for provider-owned releasers. */
@Injectable()
export class ProviderReleaserRegistry implements ProviderReleaserRegistryPort {
  private readonly releasersByProvider = new Map<string, ProviderReleaser>();

  constructor(
    @Optional()
    @Inject(PROVIDER_RELEASERS)
    releasers: readonly ProviderReleaser[] = [],
  ) {
    releasers.forEach((releaser) => this.register(releaser));
  }

  register(releaser: ProviderReleaser): void {
    if (this.releasersByProvider.has(releaser.provider)) {
      throw new Error(`Duplicate provider releaser for: ${releaser.provider}`);
    }
    this.releasersByProvider.set(releaser.provider, releaser);
  }

  get(provider: string): ProviderReleaser | undefined {
    return this.releasersByProvider.get(provider);
  }
}
