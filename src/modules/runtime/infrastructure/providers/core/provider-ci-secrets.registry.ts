import { Inject, Injectable, Optional } from '@nestjs/common';

import type {
  ProviderCiSecretsInstaller,
  ProviderCiSecretsInstallerRegistryPort,
} from '../../../application/ports/provider-ci-secrets-installer.port';
import { PROVIDER_CI_SECRETS_INSTALLERS } from '../../../application/ports/provider-ci-secrets-installer.port';

/** Runtime composition registry for provider-owned CI secret installers. */
@Injectable()
export class ProviderCiSecretsInstallerRegistry implements ProviderCiSecretsInstallerRegistryPort {
  private readonly installersByProvider = new Map<
    string,
    ProviderCiSecretsInstaller
  >();

  constructor(
    @Optional()
    @Inject(PROVIDER_CI_SECRETS_INSTALLERS)
    installers: readonly ProviderCiSecretsInstaller[] = [],
  ) {
    installers.forEach((installer) => this.register(installer));
  }

  register(installer: ProviderCiSecretsInstaller): void {
    if (this.installersByProvider.has(installer.provider)) {
      throw new Error(
        `Duplicate provider CI secret installer for: ${installer.provider}`,
      );
    }
    this.installersByProvider.set(installer.provider, installer);
  }

  get(provider: string): ProviderCiSecretsInstaller | undefined {
    return this.installersByProvider.get(provider);
  }
}
