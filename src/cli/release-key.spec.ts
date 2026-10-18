import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';

import {
  generateP256PrivateKeyPem,
  p256KeyProblem,
  releaseKeyId,
} from './release-key';

describe('release key', () => {
  it('generates a P-256 PKCS#8 private key', () => {
    const pem = generateP256PrivateKeyPem();

    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(p256KeyProblem(pem, 'KEY')).toBeUndefined();
  });

  it('derives the key ID as sha256 of the public key SPKI DER', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const expected = `sha256:${createHash('sha256').update(der).digest('hex')}`;

    expect(releaseKeyId(pem)).toBe(expected);
    expect(
      createPublicKey(pem).export({ type: 'spki', format: 'der' }).equals(der),
    ).toBe(true);
  });

  it('rejects a key on another curve, naming the setting but not the key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    expect(p256KeyProblem(pem, 'ALPHACI_RELEASE_SIGNING_KEY_FILE')).toBe(
      'ALPHACI_RELEASE_SIGNING_KEY_FILE must contain a P-256 private key.',
    );
  });

  it('rejects text that is not a PEM private key', () => {
    const problem = p256KeyProblem('not a key', 'KEY');
    expect(problem).toBe('KEY does not contain a PEM private key.');
    expect(problem).not.toContain('not a key');
  });
});
