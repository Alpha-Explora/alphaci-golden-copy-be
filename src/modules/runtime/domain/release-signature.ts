import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { SIGNATURE_ALGORITHMS } from './release-manifest';

export type ReleaseSignatureFailure =
  | 'trust_keys_unconfigured'
  | 'invalid_trust_keys'
  | 'unknown_key'
  | 'unsupported_algorithm'
  | 'wrong_key_type'
  | 'invalid_signature';

export type ReleaseSignatureResult =
  | { valid: true }
  | { valid: false; reason: ReleaseSignatureFailure };

/**
 * The trust set with the backend's own signing key added under its key ID, so a
 * file-signed release verifies without hand-maintaining the setting. The derived
 * key wins over a configured entry with the same ID; an unparseable setting is
 * returned unchanged, so it still fails verification loudly.
 */
export function trustKeysWithSigner(
  trustKeysJson: string | undefined,
  signer: { keyId: string; publicKeyPem: string } | undefined,
): string | undefined {
  if (!signer) return trustKeysJson;
  if (!trustKeysJson?.trim()) {
    return JSON.stringify({ [signer.keyId]: signer.publicKeyPem });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trustKeysJson);
  } catch {
    return trustKeysJson;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return trustKeysJson;
  }
  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    [signer.keyId]: signer.publicKeyPem,
  });
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Verify the signature over the canonical manifest bytes using an explicitly
 * trusted key. The JSON setting maps stable key IDs to PEM public keys.
 */
export function verifyReleaseSignature(input: {
  algorithm: string;
  keyId: string;
  value: string;
  canonicalManifest: string;
  trustedKeysJson: string | undefined;
}): ReleaseSignatureResult {
  if (!(SIGNATURE_ALGORITHMS as readonly string[]).includes(input.algorithm)) {
    return { valid: false, reason: 'unsupported_algorithm' };
  }
  if (!input.trustedKeysJson?.trim()) {
    return { valid: false, reason: 'trust_keys_unconfigured' };
  }

  let publicPem: unknown;
  try {
    const trustedKeys: unknown = JSON.parse(input.trustedKeysJson);
    if (
      typeof trustedKeys !== 'object' ||
      trustedKeys === null ||
      Array.isArray(trustedKeys)
    ) {
      return { valid: false, reason: 'invalid_trust_keys' };
    }
    publicPem = (trustedKeys as Record<string, unknown>)[input.keyId];
  } catch {
    return { valid: false, reason: 'invalid_trust_keys' };
  }
  if (typeof publicPem !== 'string' || !publicPem.trim()) {
    return { valid: false, reason: 'unknown_key' };
  }
  if (
    !/^-----BEGIN (?:PUBLIC KEY|RSA PUBLIC KEY|EC PUBLIC KEY)-----/.test(
      publicPem.trim(),
    )
  ) {
    return { valid: false, reason: 'invalid_trust_keys' };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicPem.replace(/\\n/g, '\n'));
  } catch {
    return { valid: false, reason: 'invalid_trust_keys' };
  }
  if (
    input.algorithm === 'ecdsa-p256-sha256' &&
    (publicKey.asymmetricKeyType !== 'ec' ||
      publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
  ) {
    return { valid: false, reason: 'wrong_key_type' };
  }

  if (
    !BASE64.test(input.value) ||
    Buffer.from(input.value, 'base64').toString('base64') !== input.value
  ) {
    return { valid: false, reason: 'invalid_signature' };
  }

  try {
    return verify(
      'sha256',
      Buffer.from(input.canonicalManifest, 'utf8'),
      publicKey,
      Buffer.from(input.value, 'base64'),
    )
      ? { valid: true }
      : { valid: false, reason: 'invalid_signature' };
  } catch {
    return { valid: false, reason: 'invalid_signature' };
  }
}
