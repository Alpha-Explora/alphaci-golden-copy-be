/**
 * Where on-prem release manifests are signed, read from backend configuration.
 *
 * Cloud KMS is the production signer: ALPHACI_RELEASE_KMS_KEY_VERSION names the
 * key version, and provisioning copies it to each on-prem project's repository
 * variable of the same name. ONPREM_LAB_SIGNING_KEY_PATH is lab-only: a local
 * P-256 private key whose PEM provisioning copies to the repository secret
 * ALPHACI_RELEASE_SIGNING_KEY.
 */

export const RELEASE_SIGNING_KMS_KEY_VERSION_ENV =
  'ALPHACI_RELEASE_KMS_KEY_VERSION';
export const RELEASE_SIGNING_LAB_KEY_PATH_ENV = 'ONPREM_LAB_SIGNING_KEY_PATH';

/** projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{k}/cryptoKeyVersions/{v} */
const KMS_KEY_VERSION_NAME =
  /^projects\/[^/\s]+\/locations\/[^/\s]+\/keyRings\/[^/\s]+\/cryptoKeys\/[^/\s]+\/cryptoKeyVersions\/[^/\s]+$/;

export type ReleaseSigningSource =
  | { kind: 'kms'; keyVersion: string }
  | { kind: 'lab'; keyPath: string }
  /**
   * The KMS value is set but is not a full key-version name. This never falls
   * back to the lab key: a half-typed KMS name is an error to surface, not a
   * reason to sign with something else.
   */
  | { kind: 'invalid-kms' }
  | { kind: 'none' };

/**
 * Resolves the signing source from a configuration reader. Blank values count
 * as unset. Cloud KMS wins when both are configured.
 */
export function resolveReleaseSigningSource(
  read: (key: string) => string | undefined,
): ReleaseSigningSource {
  const keyVersion = nonBlank(read(RELEASE_SIGNING_KMS_KEY_VERSION_ENV));
  if (keyVersion !== null) {
    return KMS_KEY_VERSION_NAME.test(keyVersion)
      ? { kind: 'kms', keyVersion }
      : { kind: 'invalid-kms' };
  }
  const keyPath = nonBlank(read(RELEASE_SIGNING_LAB_KEY_PATH_ENV));
  return keyPath !== null ? { kind: 'lab', keyPath } : { kind: 'none' };
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
