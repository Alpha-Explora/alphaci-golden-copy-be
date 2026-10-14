import { Inject, Injectable, Optional } from '@nestjs/common';

import type { ProviderCiSecretsInstaller } from '../application/ports/provider-ci-secrets-installer.port';
import type { ProviderReleaser } from '../application/ports/provider-releaser.port';
import type { RuntimeEnvProviderClient } from '../application/ports/runtime-env-provider.client';
import type { DeploymentProvider } from './deployment-provider.contract';
import type { DeploymentProviderPolicy } from '../domain/deployment-provider.policy';
import type { WorkflowFragment } from './workflow-fragment.contract';

/**
 * The complete Runtime contribution for one deployment provider.
 *
 * A pack keeps provider composition together without making the application
 * orchestration layer know which provider owns a policy, client, workflow
 * fragment, or CI secret installer. Catalog-only providers, such as the
 * current GCP descriptor, may intentionally omit optional contributions.
 */
export interface RuntimeProviderPack {
  readonly id: string;
  readonly provider: DeploymentProvider;
  readonly policy?: DeploymentProviderPolicy;
  readonly client?: RuntimeEnvProviderClient;
  readonly workflowFragment?: WorkflowFragment;
  readonly ciSecretsInstaller?: ProviderCiSecretsInstaller;
  /**
   * Performs the release of an artifact the pipeline built. Absent for a
   * provider whose pipeline deploys directly, such as Vercel.
   */
  readonly releaser?: ProviderReleaser;
}

/** Nest token used by Runtime's provider composition root. */
export const RUNTIME_PROVIDER_PACKS = Symbol('RuntimeProviderPacks');

/**
 * Validated registry for provider contributions. The registry is deliberately
 * unaware of Render, Vercel, GCP, or any other vendor identifier.
 */
@Injectable()
export class RuntimeProviderPackRegistry {
  private readonly packsById = new Map<string, RuntimeProviderPack>();

  constructor(
    @Optional()
    @Inject(RUNTIME_PROVIDER_PACKS)
    packs: readonly RuntimeProviderPack[] = [],
  ) {
    packs.forEach((pack) => this.register(pack));
  }

  register(pack: RuntimeProviderPack): void {
    const id = pack.id.trim();
    if (!id) {
      throw new Error('Runtime provider packs require a non-empty id');
    }
    if (this.packsById.has(id)) {
      throw new Error(`Duplicate runtime provider pack: ${id}`);
    }
    if (pack.provider.id !== id) {
      throw new Error(
        `Provider pack '${id}' contains provider '${pack.provider.id}'`,
      );
    }
    if (pack.policy && pack.policy.providerId !== id) {
      throw new Error(
        `Provider pack '${id}' contains policy '${pack.policy.providerId}'`,
      );
    }
    if (pack.client && pack.client.provider !== id) {
      throw new Error(
        `Provider pack '${id}' contains client '${pack.client.provider}'`,
      );
    }
    if (pack.workflowFragment && pack.workflowFragment.provider !== id) {
      throw new Error(
        `Provider pack '${id}' contains workflow fragment '${pack.workflowFragment.provider}'`,
      );
    }
    // The runtime reads delivery from the provider, the pipeline builder from
    // the fragment; a pack whose two halves disagree would deploy twice or not
    // at all.
    if (
      pack.workflowFragment &&
      (pack.workflowFragment.deliveredByHost === true) !==
        (pack.provider.capabilities.connectivity === 'indirect')
    ) {
      throw new Error(
        `Provider pack '${id}' disagrees with itself about host delivery`,
      );
    }
    if (pack.ciSecretsInstaller && pack.ciSecretsInstaller.provider !== id) {
      throw new Error(
        `Provider pack '${id}' contains CI installer '${pack.ciSecretsInstaller.provider}'`,
      );
    }
    if (pack.releaser && pack.releaser.provider !== id) {
      throw new Error(
        `Provider pack '${id}' contains releaser '${pack.releaser.provider}'`,
      );
    }
    if (pack.provider.capabilities.envProvisioning !== false && !pack.client) {
      throw new Error(
        `Provider pack '${id}' enables environment provisioning but has no runtime client`,
      );
    }

    this.packsById.set(id, pack);
  }

  get(id: string): RuntimeProviderPack {
    const pack = this.packsById.get(id);
    if (!pack) {
      throw new Error(`Unknown runtime provider pack: ${id}`);
    }
    return pack;
  }

  find(id: string): RuntimeProviderPack | undefined {
    return this.packsById.get(id);
  }

  list(): RuntimeProviderPack[] {
    return [...this.packsById.values()];
  }
}
