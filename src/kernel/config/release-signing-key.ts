import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  RELEASE_SIGNING_LAB_KEY_PATH_ENV,
  RELEASE_TRUST_KEYS_ENV,
} from './release-signing.config';

/**
 * Reads the lab signing key and checks that it is a P-256 private key. Errors
 * name the setting, never the file's contents.
 */
export async function readLabSigningKey(keyPath: string): Promise<string> {
  let pem: string;
  try {
    pem = await readFile(keyPath, 'utf8');
  } catch {
    throw new Error(
      `${RELEASE_SIGNING_LAB_KEY_PATH_ENV} points to a file that cannot be read`,
    );
  }
  let keyType: string;
  let namedCurve: string | undefined;
  try {
    const key = createPrivateKey(pem);
    keyType = key.asymmetricKeyType ?? '';
    namedCurve = key.asymmetricKeyDetails?.namedCurve;
  } catch {
    throw new Error(
      `${RELEASE_SIGNING_LAB_KEY_PATH_ENV} does not contain a PEM private key`,
    );
  }
  if (keyType !== 'ec' || namedCurve !== 'prime256v1') {
    throw new Error(
      `${RELEASE_SIGNING_LAB_KEY_PATH_ENV} must contain a P-256 private key`,
    );
  }
  return pem;
}

/**
 * The key ID a lab signer sends: `sha256:` and the SHA-256 of the public key's
 * DER SubjectPublicKeyInfo, as `openssl pkey -pubout -outform DER` yields. Throws
 * when the PEM is not a usable key.
 */
export function labSigningKeyId(labPem: string): string {
  const der = publicKeyDer(labPem);
  if (der === undefined) throw new Error('lab signing key is not a usable key');
  return 'sha256:' + createHash('sha256').update(der).digest('hex');
}

/**
 * The trusted key map from ALPHACI_RELEASE_TRUST_KEYS_JSON, or undefined when
 * the setting is not a JSON object. Entries that are not strings are dropped,
 * so they can never match.
 */
export function parseTrustKeys(
  trustKeysJson: string | undefined,
): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trustKeysJson || '{}');
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Cloud KMS releases carry the exact key-version name as their key ID, so that
 * name must be a trusted entry. Returns the problem, or undefined when trusted.
 */
export function kmsTrustProblem(
  keyVersion: string,
  trustKeysJson: string | undefined,
): string | undefined {
  const keys = parseTrustKeys(trustKeysJson);
  if (keys && Object.hasOwn(keys, keyVersion)) return undefined;
  return `${RELEASE_TRUST_KEYS_ENV} must map the Cloud KMS key version ${keyVersion} to its public PEM, keyed by that exact name.`;
}

/**
 * A lab release is verified against the key ID derived from the lab key. The
 * trust entry under that ID must be the lab key's public key. Returns the
 * problem, or undefined when trusted.
 */
export function labTrustProblem(
  labPem: string,
  trustKeysJson: string | undefined,
): string | undefined {
  const keyId = labSigningKeyId(labPem);
  const keys = parseTrustKeys(trustKeysJson);
  if (!keys || !Object.hasOwn(keys, keyId)) {
    return `${RELEASE_TRUST_KEYS_ENV} has no entry for the lab key ID ${keyId}. Add the one-line trust setting from the on-prem runbook, Part 4 step 13.`;
  }
  const trusted = publicKeyDer(keys[keyId] ?? '');
  const own = publicKeyDer(labPem);
  if (trusted === undefined || own === undefined || !trusted.equals(own)) {
    return `${RELEASE_TRUST_KEYS_ENV} maps ${keyId} to a PEM that is not the public key of ${RELEASE_SIGNING_LAB_KEY_PATH_ENV}.`;
  }
  return undefined;
}

function publicKeyDer(pem: string): Buffer | undefined {
  try {
    return createPublicKey(pem).export({ type: 'spki', format: 'der' });
  } catch {
    return undefined;
  }
}
