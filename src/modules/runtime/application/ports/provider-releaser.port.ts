import type { DeploymentTargetSummary } from '../../core/deployments.types';

/**
 * Provider-owned release of an artifact the pipeline has already built.
 *
 * Releasing is the half of deployment the pipeline cannot do for itself: it
 * requires the hosting credential, and handing that to every customer
 * repository gives a repository-write token the run of the whole hosting
 * account. The pipeline says what it built; the provider that owns the target
 * performs the release here, where the credential already lives.
 *
 * A provider that deploys from CI directly - Vercel pushes a prebuilt bundle
 * with its own CLI - contributes no releaser, and the generator emits no
 * release job for it.
 */
export type ProviderReleaseStatus =
  | 'pending'
  | 'in_progress'
  | 'live'
  | 'failed';

export interface ProviderReleaseRequest {
  target: DeploymentTargetSummary;
  branch: string;
  commitSha: string;
  /** What the pipeline built, e.g. an image reference. */
  artifact?: string | undefined;
}

export interface ProviderReleaseHandle {
  /** Opaque to everything above the provider. */
  providerReleaseId: string;
  status: ProviderReleaseStatus;
  serviceUrl?: string | null;
  /** Operator-facing detail for a failure or an unfinished release. */
  message?: string | null;
  /**
   * Target `provider_metadata` keys the release changed (e.g. the image the
   * service now runs). The releaser reports them and the caller persists them,
   * so a provider never writes the deployment-target table itself.
   */
  providerMetadataUpdates?: Record<string, unknown>;
}

export interface ProviderReleaser {
  readonly provider: string;
  supports(target: DeploymentTargetSummary): boolean;
  start(request: ProviderReleaseRequest): Promise<ProviderReleaseHandle>;
  check(input: {
    target: DeploymentTargetSummary;
    providerReleaseId: string;
  }): Promise<ProviderReleaseHandle>;
}

export const PROVIDER_RELEASERS = Symbol('ProviderReleasers');

export const PROVIDER_RELEASER_REGISTRY = Symbol('ProviderReleaserRegistry');

export interface ProviderReleaserRegistryPort {
  get(provider: string): ProviderReleaser | undefined;
}
