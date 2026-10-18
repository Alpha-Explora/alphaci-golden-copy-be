export const RELEASE_SIGNER = Symbol('ReleaseSigner');

/** The public half of a backend signing key, as trust entries record it. */
export interface ReleaseSignerIdentity {
  /** `sha256:` and the SHA-256 of the public key's DER SubjectPublicKeyInfo. */
  keyId: string;
  /** SPKI public key PEM, the form a host's trust.json holds. */
  publicKeyPem: string;
}

export interface ReleaseSignature {
  algorithm: 'ecdsa-p256-sha256';
  keyId: string;
  /** Base64 of the DER-encoded ECDSA signature over the canonical manifest bytes. */
  value: string;
}

/**
 * Signs canonical release manifests. `runner` means CI signs and this port is
 * never asked to sign; `file` means the backend signs with its own key.
 */
export interface ReleaseSigner {
  readonly mode: 'runner' | 'file';
  /** The trusted public identity; undefined when unusable or CI signs. */
  readonly identity: ReleaseSignerIdentity | undefined;
  /** Why this signer cannot sign now, or undefined when it can. */
  readonly problem: string | undefined;
  /** Signs the canonical manifest bytes. Throws when the signer has a problem. */
  sign(canonicalManifest: string): ReleaseSignature;
}
