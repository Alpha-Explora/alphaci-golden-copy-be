import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { labSigningKeyId } from '#kernel/config/release-signing-key';

import {
  canonicalJson,
  manifestFromRelease,
  manifestProblem,
  type ReleaseManifest,
} from '../../domain/release-manifest';
import {
  trustKeysWithSigner,
  verifyReleaseSignature,
} from '../../domain/release-signature';
import { createReleaseSigner } from './release-signer';

const KEY_ENV = 'ALPHACI_RELEASE_SIGNING_KEY_FILE';

const release = {
  id: '6f1c2b8e-3d4a-4c5b-9e8f-1a2b3c4d5e6f',
  projectId: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a',
  sourceEnvironmentId: '4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d',
  sourceBranch: 'dev',
  commitSha: 'a'.repeat(40),
  createdAt: '2026-10-19T10:00:00.000Z',
  artifacts: [
    {
      slot: 'backend' as const,
      image: 'ghcr.io/alpha-explora/orders-api',
      digest: 'sha256:' + 'b'.repeat(64),
    },
  ],
  workflowRun: {
    provider: 'github_actions' as const,
    repo: 'Alpha-Explora/orders-api',
    runId: '12345678',
    url: 'https://github.com/Alpha-Explora/orders-api/actions/runs/12345678',
  },
};

describe('file release signer', () => {
  const pair = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  let dir: string;
  let keyPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'alphaci-release-signer-'));
    keyPath = join(dir, 'release-signing.key');
    writeFileSync(keyPath, pair.privateKey);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fileSigner = () =>
    createReleaseSigner((key) =>
      key === 'ALPHACI_RELEASE_SIGNER'
        ? 'file'
        : key === KEY_ENV
          ? keyPath
          : undefined,
    );

  it('derives the key ID from the key, as the lab key ID is derived', () => {
    const signer = fileSigner();
    expect(signer.mode).toBe('file');
    expect(signer.problem).toBeUndefined();
    expect(signer.identity?.keyId).toBe(labSigningKeyId(pair.privateKey));
    expect(signer.identity?.keyId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(signer.identity?.publicKeyPem).toBe(pair.publicKey);
  });

  it('signs the canonical manifest with ecdsa-p256-sha256 as a DER signature', () => {
    const canonical = canonicalJson(manifestFromRelease(release));
    const signature = fileSigner().sign(canonical);
    expect(signature.algorithm).toBe('ecdsa-p256-sha256');
    expect(signature.keyId).toBe(labSigningKeyId(pair.privateKey));
    // DER ECDSA over P-256 starts with a SEQUENCE tag, not the raw r||s form.
    const der = Buffer.from(signature.value, 'base64');
    expect(der[0]).toBe(0x30);
    expect(
      verify(
        'sha256',
        Buffer.from(canonical, 'utf8'),
        createPublicKey(pair.publicKey),
        der,
      ),
    ).toBe(true);
  });

  it('is accepted by the backend verifier once its key is in the trust set', () => {
    const canonical = canonicalJson(manifestFromRelease(release));
    const signer = fileSigner();
    const signature = signer.sign(canonical);
    expect(
      verifyReleaseSignature({
        algorithm: signature.algorithm,
        keyId: signature.keyId,
        value: signature.value,
        canonicalManifest: canonical,
        trustedKeysJson: trustKeysWithSigner(undefined, signer.identity),
      }),
    ).toEqual({ valid: true });
  });

  it('produces a signature that the host agent accepts with openssl dgst -verify', () => {
    const openssl = spawnSync('openssl', ['version']);
    if (openssl.status !== 0) {
      // Skipped on machines without openssl on PATH; the node verify above still runs.
      return;
    }
    const manifest: ReleaseManifest = manifestFromRelease(release);
    const canonical = canonicalJson(manifest);
    const signature = fileSigner().sign(canonical);
    const canonicalPath = join(dir, 'canonical.json');
    const signaturePath = join(dir, 'signature.der');
    const publicPath = join(dir, 'trust.pub.pem');
    writeFileSync(canonicalPath, canonical);
    // The host agent base64-decodes envelope.signature.value to a DER file.
    writeFileSync(signaturePath, Buffer.from(signature.value, 'base64'));
    writeFileSync(publicPath, pair.publicKey);

    const result = spawnSync('openssl', [
      'dgst',
      '-sha256',
      '-verify',
      publicPath,
      '-signature',
      signaturePath,
      canonicalPath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain('Verified OK');

    // The same signature must not verify a manifest that changed by one byte.
    writeFileSync(canonicalPath, canonical.replace('dev', 'qa'));
    const tampered = spawnSync('openssl', [
      'dgst',
      '-sha256',
      '-verify',
      publicPath,
      '-signature',
      signaturePath,
      canonicalPath,
    ]);
    expect(tampered.status).not.toBe(0);
    expect(readFileSync(canonicalPath, 'utf8')).not.toBe(canonical);
  });

  it('describes a missing key file without its path contents, and cannot sign', () => {
    const signer = createReleaseSigner((key) =>
      key === 'ALPHACI_RELEASE_SIGNER'
        ? 'file'
        : key === KEY_ENV
          ? join(dir, 'absent.key')
          : undefined,
    );
    expect(signer.mode).toBe('file');
    expect(signer.identity).toBeUndefined();
    expect(signer.problem).toBe(
      'ALPHACI_RELEASE_SIGNING_KEY_FILE points to a file that cannot be read.',
    );
    expect(() => signer.sign('{}')).toThrow(/cannot be read/);
  });

  it('refuses a key that is not P-256 before it can sign', () => {
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const rsaPath = join(dir, 'rsa.key');
    writeFileSync(rsaPath, rsa.privateKey);
    const signer = createReleaseSigner((key) =>
      key === 'ALPHACI_RELEASE_SIGNER'
        ? 'file'
        : key === KEY_ENV
          ? rsaPath
          : undefined,
    );
    expect(signer.identity).toBeUndefined();
    expect(signer.problem).toBe(
      'ALPHACI_RELEASE_SIGNING_KEY_FILE must contain a P-256 private key',
    );
  });

  it('reports a file mode with no key path, and a Cloud KMS conflict, as problems', () => {
    expect(
      createReleaseSigner((key) =>
        key === 'ALPHACI_RELEASE_SIGNER' ? 'file' : undefined,
      ).problem,
    ).toMatch(/ALPHACI_RELEASE_SIGNING_KEY_FILE must name/);
    expect(
      createReleaseSigner((key) =>
        key === 'ALPHACI_RELEASE_SIGNER'
          ? 'file'
          : key === KEY_ENV
            ? keyPath
            : key === 'ALPHACI_RELEASE_KMS_KEY_VERSION'
              ? 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1'
              : undefined,
      ).problem,
    ).toMatch(/cannot be combined with Cloud KMS/);
  });

  it('is the runner signer, which never signs, when the mode is unset', () => {
    const signer = createReleaseSigner(() => undefined);
    expect(signer.mode).toBe('runner');
    expect(signer.identity).toBeUndefined();
    expect(() => signer.sign('{}')).toThrow(/CI runner/);
  });
});

describe('manifest built from a registered release', () => {
  it('has the sign-release job fields and passes the backend manifest check', () => {
    const manifest = manifestFromRelease(release);
    expect(Object.keys(manifest).sort()).toEqual([
      'artifacts',
      'commitSha',
      'createdAt',
      'projectId',
      'releaseId',
      'schemaVersion',
      'sourceBranch',
      'sourceEnvironmentId',
      'workflowRun',
    ]);
    expect(
      manifestProblem(manifest, { ...release, releaseId: release.id }),
    ).toBeNull();
  });
});
