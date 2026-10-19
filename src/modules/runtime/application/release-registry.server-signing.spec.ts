import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceUnavailableException } from '@nestjs/common';

import { labSigningKeyId } from '#kernel/config/release-signing-key';

import { canonicalJson, manifestSha256 } from '../domain/release-manifest';
import {
  RunnerReleaseSigner,
  createReleaseSigner,
} from '../infrastructure/release-signing/release-signer';
import type { ReleaseSigner } from './ports/release-signer.port';
import { ReleaseRegistryService } from './release-registry.service';

const PROJECT = '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a';
const ENVIRONMENT = '4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d';
const RELEASE = '6f1c2b8e-3d4a-4c5b-9e8f-1a2b3c4d5e6f';
const IMAGE = 'ghcr.io/alpha-explora/orders-api';
const DIGEST = 'sha256:' + 'b'.repeat(64);
const COMMIT = 'a'.repeat(40);
const workflowRun = {
  provider: 'github_actions' as const,
  repo: 'Alpha-Explora/orders-api',
  runId: '12345678',
  url: 'https://github.com/Alpha-Explora/orders-api/actions/runs/12345678',
};

const pair = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const otherPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const otherPublicPem = otherPair.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();

describe('file-mode release signing on registration', () => {
  let dir: string;
  let keyPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'alphaci-registry-signing-'));
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
        : key === 'ALPHACI_RELEASE_SIGNING_KEY_FILE'
          ? keyPath
          : undefined,
    );

  interface StoredRelease {
    id: string;
    projectId: string;
    sourceEnvironmentId: string;
    sourceBranch: string;
    commitSha: string;
    workflowRun: typeof workflowRun;
    artifacts: Array<{ slot: string; image: string; digest: string }>;
    verificationStatus: 'pending' | 'verified';
    manifest: unknown;
    manifestSha256: string | null;
    signature: { algorithm: string; keyId: string; value: string } | null;
    createdAt: string;
    verifiedAt: string | null;
  }

  /** A registry over in-memory releases; the first environment has one backend target. */
  function harness(options: {
    signer?: ReleaseSigner;
    connectivity?: 'direct' | 'indirect';
    trustKeys?: string;
    registeredVerified?: boolean;
  }) {
    const base: StoredRelease = {
      id: RELEASE,
      projectId: PROJECT,
      sourceEnvironmentId: ENVIRONMENT,
      sourceBranch: 'dev',
      commitSha: COMMIT,
      workflowRun,
      artifacts: [{ slot: 'backend', image: IMAGE, digest: DIGEST }],
      verificationStatus: 'pending' as 'pending' | 'verified',
      manifest: null,
      manifestSha256: null,
      signature: null,
      createdAt: '2026-10-19T10:00:00.000Z',
      verifiedAt: null,
    };
    let current: StoredRelease = base;
    const releases = {
      registerRelease: jest.fn(async () => {
        current = options.registeredVerified
          ? { ...base, verificationStatus: 'verified' }
          : base;
        return current;
      }),
      findRelease: jest.fn(async () => current),
      attachManifest: jest.fn(
        async (input: {
          manifest: unknown;
          manifestSha256: string;
          signature: { algorithm: string; keyId: string; value: string };
        }) => {
          current = {
            ...current,
            verificationStatus: 'verified',
            manifest: input.manifest as never,
            manifestSha256: input.manifestSha256,
            signature: input.signature,
          };
          return true;
        },
      ),
      failUnsignedHostDeployment: jest.fn(async () => null),
      listReleaseDeployments: jest.fn(async () => []),
    };
    const projects = {
      listProjectEnvironments: jest.fn(async () => [
        {
          id: ENVIRONMENT,
          slug: 'dev',
          sourceBranch: 'dev',
          position: 0,
          role: 'non_production',
        },
      ]),
    };
    const deploymentTargets = {
      listDeploymentTargets: jest.fn(async () => [
        { id: 'target-1', provider: 'onprem-compose', slot: 'backend' },
      ]),
    };
    const targets = {
      resolve: jest.fn(async () => ({ id: 'target-1', provider: 'x' })),
    };
    const providerRegistry = {
      find: () => ({
        capabilities: { connectivity: options.connectivity ?? 'indirect' },
      }),
    };
    const configService = {
      getOrThrow: () => ({ envProvisioning: { enabled: true } }),
      get: (key: string) =>
        key === 'ALPHACI_RELEASE_TRUST_KEYS_JSON'
          ? options.trustKeys
          : undefined,
    };
    const service = new ReleaseRegistryService(
      releases as never,
      deploymentTargets as never,
      projects as never,
      targets as never,
      configService as never,
      providerRegistry as never,
      undefined,
      undefined,
      undefined,
      options.signer,
    );
    const register = () =>
      service.registerRelease({
        projectId: PROJECT,
        repoFullName: workflowRun.repo,
        sourceEnvironmentId: ENVIRONMENT,
        sourceBranch: 'dev',
        commitSha: COMMIT,
        artifacts: [{ slot: 'backend', reference: `${IMAGE}@${DIGEST}` }],
        workflowRun,
      });
    return { service, releases, register };
  }

  it('signs and verifies the release at once, with the manifest the sign job would build', async () => {
    const { register, releases } = harness({ signer: fileSigner() });
    const view = await register();

    expect(view.verificationStatus).toBe('verified');
    expect(releases.attachManifest).toHaveBeenCalledTimes(1);
    const stored = releases.attachManifest.mock.calls[0]![0] as {
      manifest: Record<string, unknown>;
      manifestSha256: string;
      signature: { algorithm: string; keyId: string; value: string };
    };
    expect(stored.manifest).toEqual({
      schemaVersion: 1,
      releaseId: RELEASE,
      projectId: PROJECT,
      sourceEnvironmentId: ENVIRONMENT,
      sourceBranch: 'dev',
      commitSha: COMMIT,
      createdAt: '2026-10-19T10:00:00.000Z',
      artifacts: [{ slot: 'backend', image: IMAGE, digest: DIGEST }],
      workflowRun,
    });
    expect(stored.manifestSha256).toBe(manifestSha256(stored.manifest));
    expect(stored.signature.algorithm).toBe('ecdsa-p256-sha256');
    expect(stored.signature.keyId).toBe(labSigningKeyId(pair.privateKey));
    expect(
      verify(
        'sha256',
        Buffer.from(canonicalJson(stored.manifest), 'utf8'),
        createPublicKey(pair.publicKey),
        Buffer.from(stored.signature.value, 'base64'),
      ),
    ).toBe(true);
  });

  it('trusts the derived key with no trust setting, and beside a configured other key', async () => {
    const alone = harness({ signer: fileSigner() });
    await expect(alone.register()).resolves.toMatchObject({
      verificationStatus: 'verified',
    });
    const beside = harness({
      signer: fileSigner(),
      trustKeys: JSON.stringify({ 'other-key': otherPublicPem }),
    });
    await expect(beside.register()).resolves.toMatchObject({
      verificationStatus: 'verified',
    });
  });

  it('never signs a release that is already verified, because a second signature would conflict', async () => {
    const signer = fileSigner();
    const sign = jest.spyOn(signer, 'sign');
    const { register, releases } = harness({
      signer,
      registeredVerified: true,
    });
    await expect(register()).resolves.toMatchObject({
      verificationStatus: 'verified',
    });
    expect(sign).not.toHaveBeenCalled();
    expect(releases.attachManifest).not.toHaveBeenCalled();
  });

  it('accepts a repeated attach of the backend signature as the same signed manifest', async () => {
    const { service, register, releases } = harness({ signer: fileSigner() });
    await register();
    const stored = releases.attachManifest.mock.calls[0]![0] as {
      manifest: Record<string, unknown>;
      manifestSha256: string;
      signature: { algorithm: string; keyId: string; value: string };
    };
    await expect(
      service.attachManifest(PROJECT, RELEASE, {
        manifest: stored.manifest,
        manifestSha256: stored.manifestSha256,
        signature: stored.signature,
      }),
    ).resolves.toMatchObject({ verificationStatus: 'verified' });
    expect(releases.attachManifest).toHaveBeenCalledTimes(1);
  });

  it('refuses before writing anything when the file key cannot be used', async () => {
    const unusable = createReleaseSigner((key) =>
      key === 'ALPHACI_RELEASE_SIGNER'
        ? 'file'
        : key === 'ALPHACI_RELEASE_SIGNING_KEY_FILE'
          ? join(dir, 'absent.key')
          : undefined,
    );
    const { register, releases } = harness({ signer: unusable });
    await expect(register()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(releases.registerRelease).not.toHaveBeenCalled();
  });

  it('keeps runner mode unchanged: the release stays pending for CI to sign', async () => {
    const { register, releases } = harness({
      signer: new RunnerReleaseSigner(),
    });
    await expect(register()).resolves.toMatchObject({
      verificationStatus: 'pending',
    });
    expect(releases.attachManifest).not.toHaveBeenCalled();
  });

  it('fails the unsigned host deployment when backend signing fails for a host release', async () => {
    const signer = fileSigner();
    jest.spyOn(signer, 'sign').mockImplementation(() => {
      throw new Error('signer offline');
    });
    const { register, releases } = harness({
      signer,
      connectivity: 'indirect',
    });
    await expect(register()).rejects.toThrow('signer offline');
    expect(releases.failUnsignedHostDeployment).toHaveBeenCalledWith(
      RELEASE,
      'Release signing failed before host delivery.',
    );
  });

  it('leaves a workflow-delivered release pending when backend signing fails', async () => {
    const signer = fileSigner();
    jest.spyOn(signer, 'sign').mockImplementation(() => {
      throw new Error('signer offline');
    });
    const { register, releases } = harness({
      signer,
      connectivity: 'direct',
    });
    await expect(register()).rejects.toThrow('signer offline');
    expect(releases.failUnsignedHostDeployment).not.toHaveBeenCalled();
  });
});
