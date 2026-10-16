/**
 * Where on-prem release manifests are signed, read from backend configuration.
 *
 * Cloud KMS is the production signer. It needs three settings: the key version
 * that signs (ALPHACI_RELEASE_KMS_KEY_VERSION), and the Workload Identity
 * provider and service account the generated sign-release job uses to exchange
 * its GitHub OIDC token. The signer pool is separate from the Cloud Run runtime
 * pool (GCP_WORKLOAD_IDENTITY_PROVIDER). Without all three, Cloud KMS is not
 * configured.
 *
 * ONPREM_LAB_SIGNING_KEY_PATH is lab-only: a local P-256 private key that
 * provisioning copies into the repository secret ALPHACI_RELEASE_SIGNING_KEY.
 * It is used only when Cloud KMS is not configured at all.
 */

export const RELEASE_SIGNING_KMS_KEY_VERSION_ENV =
  'ALPHACI_RELEASE_KMS_KEY_VERSION';
export const RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV =
  'ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER';
export const RELEASE_SIGNER_SERVICE_ACCOUNT_ENV =
  'ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT';
export const RELEASE_SIGNING_LAB_KEY_PATH_ENV = 'ONPREM_LAB_SIGNING_KEY_PATH';
export const RELEASE_TRUST_KEYS_ENV = 'ALPHACI_RELEASE_TRUST_KEYS_JSON';

/** Matches the check in the sign-release workflow: the version number is digits. */
const KMS_KEY_VERSION_NAME =
  /^projects\/[^/\s]+\/locations\/[^/\s]+\/keyRings\/[^/\s]+\/cryptoKeys\/[^/\s]+\/cryptoKeyVersions\/\d+$/;
const WORKLOAD_IDENTITY_PROVIDER_NAME =
  /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/\s]+\/providers\/[^/\s]+$/;
const SERVICE_ACCOUNT_EMAIL = /^[^@\s/]+@[^@\s/]+\.iam\.gserviceaccount\.com$/;

/** Identity the sign-release job exchanges its OIDC token for; not a secret. */
export interface ReleaseSigner {
  workloadIdentityProvider: string;
  serviceAccount: string;
}

export type ReleaseSigningSource =
  | { kind: 'kms'; keyVersion: string; signer: ReleaseSigner }
  | { kind: 'lab'; keyPath: string }
  /**
   * A signing setting is set but unusable. This never falls back to the lab
   * key: a half-configured signer is an error to surface, not a reason to sign
   * with something else.
   */
  | { kind: 'invalid'; problem: string }
  | { kind: 'none' };

/**
 * Resolves the signing source from a configuration reader. Blank values count
 * as unset. Any Cloud KMS setting selects the Cloud KMS path, so an incomplete
 * Cloud KMS configuration is invalid and never falls through to the lab key.
 * The lab key is used only when no Cloud KMS setting is present at all.
 */
export function resolveReleaseSigningSource(
  read: (key: string) => string | undefined,
): ReleaseSigningSource {
  const keyVersion = nonBlank(read(RELEASE_SIGNING_KMS_KEY_VERSION_ENV));
  const signerSet =
    nonBlank(read(RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV)) !== null ||
    nonBlank(read(RELEASE_SIGNER_SERVICE_ACCOUNT_ENV)) !== null;
  if (keyVersion === null && signerSet) {
    return {
      kind: 'invalid',
      problem: `${RELEASE_SIGNING_KMS_KEY_VERSION_ENV} must be set when the Cloud KMS signer is configured.`,
    };
  }
  if (keyVersion !== null) {
    if (!KMS_KEY_VERSION_NAME.test(keyVersion)) {
      return {
        kind: 'invalid',
        problem: `${RELEASE_SIGNING_KMS_KEY_VERSION_ENV} must be a full Cloud KMS key version name ending in /cryptoKeyVersions/<number>.`,
      };
    }
    const signer = resolveReleaseSigner(read);
    if ('problem' in signer)
      return { kind: 'invalid', problem: signer.problem };
    return { kind: 'kms', keyVersion, signer: signer.signer };
  }
  const keyPath = nonBlank(read(RELEASE_SIGNING_LAB_KEY_PATH_ENV));
  return keyPath !== null ? { kind: 'lab', keyPath } : { kind: 'none' };
}

/**
 * The signer identity for generated sign-release jobs, or undefined unless
 * Cloud KMS is fully configured. Pipelines built without it keep the workflow's
 * own fallbacks.
 */
export function releaseSignerFor(
  read: (key: string) => string | undefined,
): ReleaseSigner | undefined {
  const source = resolveReleaseSigningSource(read);
  return source.kind === 'kms' ? source.signer : undefined;
}

function resolveReleaseSigner(
  read: (key: string) => string | undefined,
): { signer: ReleaseSigner } | { problem: string } {
  const provider = nonBlank(
    read(RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV),
  );
  const serviceAccount = nonBlank(read(RELEASE_SIGNER_SERVICE_ACCOUNT_ENV));
  if (provider === null || serviceAccount === null) {
    const missing = [
      provider === null && RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV,
      serviceAccount === null && RELEASE_SIGNER_SERVICE_ACCOUNT_ENV,
    ].filter(Boolean);
    return {
      problem: `${missing.join(' and ')} must be set for Cloud KMS signing.`,
    };
  }
  if (!WORKLOAD_IDENTITY_PROVIDER_NAME.test(provider)) {
    return {
      problem: `${RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV} must be a full Workload Identity provider name (projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>).`,
    };
  }
  if (!SERVICE_ACCOUNT_EMAIL.test(serviceAccount)) {
    return {
      problem: `${RELEASE_SIGNER_SERVICE_ACCOUNT_ENV} must be a service account email ending in .iam.gserviceaccount.com.`,
    };
  }
  return {
    signer: { workloadIdentityProvider: provider, serviceAccount },
  };
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
