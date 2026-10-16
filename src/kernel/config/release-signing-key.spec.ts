import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  kmsTrustProblem,
  labSigningKeyId,
  labTrustProblem,
  parseTrustKeys,
  readLabSigningKey,
} from './release-signing-key';

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';

function keyPair(namedCurve = 'prime256v1') {
  return generateKeyPairSync('ec', {
    namedCurve,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

describe('readLabSigningKey', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lab-signing-key-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the PEM of a P-256 private key unchanged', async () => {
    const { privateKey } = keyPair();
    const keyPath = join(tempDir, 'key.pem');
    writeFileSync(keyPath, privateKey);

    await expect(readLabSigningKey(keyPath)).resolves.toBe(privateKey);
  });

  it('rejects a private key on another curve, naming the setting only', async () => {
    const keyPath = join(tempDir, 'p384.pem');
    writeFileSync(keyPath, keyPair('secp384r1').privateKey);

    await expect(readLabSigningKey(keyPath)).rejects.toThrow(
      'ONPREM_LAB_SIGNING_KEY_PATH must contain a P-256 private key',
    );
  });

  it('rejects content that is not a PEM private key without echoing it', async () => {
    const keyPath = join(tempDir, 'garbage.pem');
    writeFileSync(keyPath, 'not-a-key-SECRET-MATERIAL');

    const error = await readLabSigningKey(keyPath).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'does not contain a PEM private key',
    );
    expect((error as Error).message).not.toContain('SECRET-MATERIAL');
  });

  it('names the setting when the file cannot be read', async () => {
    await expect(
      readLabSigningKey(join(tempDir, 'absent.key')),
    ).rejects.toThrow(
      'ONPREM_LAB_SIGNING_KEY_PATH points to a file that cannot be read',
    );
  });
});

describe('labSigningKeyId', () => {
  it('is sha256 over the DER SubjectPublicKeyInfo, as the sign-release job derives it', () => {
    const { privateKey, publicKey } = keyPair();
    const spkiDer = createPublicKey(publicKey).export({
      type: 'spki',
      format: 'der',
    });

    expect(labSigningKeyId(privateKey)).toBe(
      'sha256:' + createHash('sha256').update(spkiDer).digest('hex'),
    );
  });

  it('is the same for the private key and its public key', () => {
    const { privateKey, publicKey } = keyPair();

    expect(labSigningKeyId(publicKey)).toBe(labSigningKeyId(privateKey));
  });
});

describe('parseTrustKeys', () => {
  it('returns the object of PEM strings', () => {
    expect(parseTrustKeys('{"id":"pem"}')).toEqual({ id: 'pem' });
  });

  it('treats an empty setting as no keys and drops non-string entries', () => {
    expect(parseTrustKeys(undefined)).toEqual({});
    expect(parseTrustKeys('{"a":"pem","b":1}')).toEqual({ a: 'pem' });
  });

  it.each(['not json', '[]', '"text"', 'null'])(
    'reports an unusable setting (%s) as undefined',
    (raw) => {
      expect(parseTrustKeys(raw)).toBeUndefined();
    },
  );
});

describe('kmsTrustProblem', () => {
  it('passes when the exact key version name is a trusted entry', () => {
    const json = JSON.stringify({ [KEY_VERSION]: keyPair().publicKey });

    expect(kmsTrustProblem(KEY_VERSION, json)).toBeUndefined();
  });

  it('reports a key version that is not trusted, or a setting that is unusable', () => {
    const other = KEY_VERSION.replace(/3$/, '4');
    const json = JSON.stringify({ [other]: keyPair().publicKey });

    expect(kmsTrustProblem(KEY_VERSION, json)).toContain(KEY_VERSION);
    expect(kmsTrustProblem(KEY_VERSION, 'not json')).toContain(KEY_VERSION);
  });
});

describe('labTrustProblem', () => {
  it('passes when the lab key ID maps to the lab key’s own public key', () => {
    const { privateKey, publicKey } = keyPair();
    const json = JSON.stringify({ [labSigningKeyId(privateKey)]: publicKey });

    expect(labTrustProblem(privateKey, json)).toBeUndefined();
  });

  it('reports a missing entry for the lab key ID', () => {
    const { privateKey } = keyPair();

    expect(labTrustProblem(privateKey, '{}')).toContain(
      labSigningKeyId(privateKey),
    );
  });

  it('reports an entry under the right ID whose PEM is a different key', () => {
    const { privateKey } = keyPair();
    const other = keyPair();
    const json = JSON.stringify({
      [labSigningKeyId(privateKey)]: other.publicKey,
    });

    expect(labTrustProblem(privateKey, json)).toContain(
      'is not the public key of',
    );
  });
});
