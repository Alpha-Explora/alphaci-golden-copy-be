import { generateKeyPairSync, sign } from 'node:crypto';

import { canonicalJson } from './release-manifest';
import { verifyReleaseSignature } from './release-signature';

describe('release signature verification', () => {
  const trusted = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyId = 'projects/alphaci/keys/release/1';
  const manifest = { schemaVersion: 1, releaseId: 'release-1' };
  const canonicalManifest = canonicalJson(manifest);
  const signature = sign(
    'sha256',
    Buffer.from(canonicalManifest),
    trusted.privateKey,
  ).toString('base64');
  const trustedKeysJson = JSON.stringify({
    [keyId]: trusted.publicKey.export({ type: 'spki', format: 'pem' }),
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    algorithm: 'ecdsa-p256-sha256',
    keyId,
    value: signature,
    canonicalManifest,
    trustedKeysJson,
    ...overrides,
  });

  it('accepts a valid P-256 signature over the canonical manifest', () => {
    expect(verifyReleaseSignature(input())).toEqual({ valid: true });
  });

  it.each([
    [
      'missing trust configuration',
      { trustedKeysJson: undefined },
      'trust_keys_unconfigured',
    ],
    [
      'malformed trust configuration',
      { trustedKeysJson: '{' },
      'invalid_trust_keys',
    ],
    [
      'private key configured where a public key is required',
      {
        trustedKeysJson: JSON.stringify({
          [keyId]: trusted.privateKey.export({
            type: 'pkcs8',
            format: 'pem',
          }),
        }),
      },
      'invalid_trust_keys',
    ],
    ['unknown key ID', { keyId: 'untrusted-key' }, 'unknown_key'],
    ['unsupported algorithm', { algorithm: 'none' }, 'unsupported_algorithm'],
    [
      'signature from another key',
      {
        value: sign(
          'sha256',
          Buffer.from(canonicalManifest),
          other.privateKey,
        ).toString('base64'),
      },
      'invalid_signature',
    ],
    [
      'tampered canonical bytes',
      { canonicalManifest: canonicalManifest + ' ' },
      'invalid_signature',
    ],
    ['malformed base64', { value: 'not a signature' }, 'invalid_signature'],
    [
      'wrong key type',
      {
        trustedKeysJson: JSON.stringify({
          [keyId]: generateKeyPairSync('rsa', {
            modulusLength: 2048,
          }).publicKey.export({ type: 'spki', format: 'pem' }),
        }),
      },
      'wrong_key_type',
    ],
  ] as const)('rejects %s', (_name, overrides, reason) => {
    expect(verifyReleaseSignature(input(overrides))).toEqual({
      valid: false,
      reason,
    });
  });
});
