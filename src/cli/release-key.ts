import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';

/**
 * The release signing key the backend signs manifests with (file mode). Pure
 * crypto with no I/O, so the CLI and its tests share one definition of "usable"
 * and of the key ID.
 */

/** A new P-256 private key as PKCS#8 PEM, the form the backend reads. */
export function generateP256PrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/**
 * Why a PEM is not a usable P-256 private key, or undefined when it is. Never
 * includes the key material in the message.
 */
export function p256KeyProblem(
  pem: string,
  setting: string,
): string | undefined {
  let keyType: string | undefined;
  let namedCurve: string | undefined;
  try {
    const key = createPrivateKey(pem);
    keyType = key.asymmetricKeyType;
    namedCurve = key.asymmetricKeyDetails?.namedCurve;
  } catch {
    return `${setting} does not contain a PEM private key.`;
  }
  if (keyType !== 'ec' || namedCurve !== 'prime256v1') {
    return `${setting} must contain a P-256 private key.`;
  }
  return undefined;
}

/**
 * The key ID the signed manifests carry: `sha256:` and the SHA-256 of the public
 * key's DER SubjectPublicKeyInfo. The same derivation the on-prem host agent
 * trusts, so a customer can compare it with a trust entry. Throws when the PEM
 * is not a private key.
 */
export function releaseKeyId(pem: string): string {
  const der = createPublicKey(createPrivateKey(pem)).export({
    type: 'spki',
    format: 'der',
  });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}
