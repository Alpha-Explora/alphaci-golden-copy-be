import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  RELEASE_SIGNING_KEY_FILE_ENV,
  resolveServerSigning,
} from '#kernel/config/release-signing.config';
import {
  labSigningKeyId,
  p256PrivateKeyProblem,
} from '#kernel/config/release-signing-key';

import type {
  ReleaseSignature,
  ReleaseSigner,
  ReleaseSignerIdentity,
} from '../../application/ports/release-signer.port';

/** Runner mode: CI signs. The backend never signs, so it is never asked to. */
export class RunnerReleaseSigner implements ReleaseSigner {
  readonly mode = 'runner' as const;
  readonly identity = undefined;
  readonly problem = undefined;

  sign(): ReleaseSignature {
    throw new Error('Release manifests are signed by the CI runner.');
  }
}

/**
 * File mode: the backend signs with a P-256 key it reads from a file. The
 * signature is ecdsa-p256-sha256 over the canonical manifest bytes, DER-encoded
 * as `openssl dgst -sha256 -sign` writes it, which is what the host agent verifies.
 */
export class FileReleaseSigner implements ReleaseSigner {
  readonly mode = 'file' as const;

  constructor(
    readonly identity: ReleaseSignerIdentity | undefined,
    readonly problem: string | undefined,
    private readonly key?: KeyObject,
  ) {}

  sign(canonicalManifest: string): ReleaseSignature {
    if (this.problem !== undefined || !this.identity || !this.key) {
      throw new Error(this.problem ?? 'The release signing key is unusable.');
    }
    const der = signBytes(
      'sha256',
      Buffer.from(canonicalManifest, 'utf8'),
      this.key,
    );
    return {
      algorithm: 'ecdsa-p256-sha256',
      keyId: this.identity.keyId,
      value: der.toString('base64'),
    };
  }
}

/**
 * The signer the configuration selects. An unusable file-mode configuration
 * still yields a file-mode signer carrying its problem, so registration refuses
 * before writing and readiness can name the cause. Reads the key once, at boot.
 */
export function createReleaseSigner(
  read: (key: string) => string | undefined,
): ReleaseSigner {
  const config = resolveServerSigning(read);
  if (config.mode === 'runner') return new RunnerReleaseSigner();
  if (config.mode === 'invalid') {
    return new FileReleaseSigner(undefined, config.problem);
  }
  let pem: string;
  try {
    pem = readFileSync(config.keyPath, 'utf8');
  } catch {
    return new FileReleaseSigner(
      undefined,
      `${RELEASE_SIGNING_KEY_FILE_ENV} points to a file that cannot be read.`,
    );
  }
  const problem = p256PrivateKeyProblem(pem, RELEASE_SIGNING_KEY_FILE_ENV);
  if (problem !== undefined) return new FileReleaseSigner(undefined, problem);
  const key = createPrivateKey(pem);
  return new FileReleaseSigner(
    {
      keyId: labSigningKeyId(pem),
      publicKeyPem: createPublicKey(key)
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    },
    undefined,
    key,
  );
}
