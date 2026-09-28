import {
  canonicalJson,
  manifestProblem,
  manifestSha256,
  parseImageReference,
  type ReleaseManifest,
  type RegisteredReleaseFacts,
} from './release-manifest';

/*
 * Failure modes the E2E suite cannot reach cheaply, because they are about the
 * exact bytes a host verifies:
 * - two equal manifests with different key order hash differently;
 * - array order is lost, or a value JSON cannot represent is silently encoded;
 * - a floating tag, a tag beside a digest, or a short digest is accepted;
 * - a manifest that restates the release with any field changed is accepted.
 */
const digest = 'sha256:' + 'a'.repeat(64);
const release: RegisteredReleaseFacts = {
  releaseId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  sourceEnvironmentId: '33333333-3333-4333-8333-333333333333',
  sourceBranch: 'dev',
  commitSha: 'b'.repeat(40),
  artifacts: [{ slot: 'backend', image: 'ghcr.io/acme/api', digest }],
  workflowRun: {
    provider: 'github_actions',
    repo: 'acme/api',
    runId: '42',
    url: 'https://github.com/acme/api/actions/runs/42',
  },
};
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  ...release,
  createdAt: '2026-09-28T00:00:00.000Z',
};

describe('release manifest canonical form', () => {
  it('hashes equal manifests identically regardless of key order', () => {
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    expect(manifestSha256(reordered)).toBe(manifestSha256(manifest));
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,1]},"b":1}',
    );
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
  });
});

describe('release image references', () => {
  it.each([
    ['ghcr.io/acme/api:latest', 'a floating tag'],
    ['ghcr.io/acme/api:1.0@' + digest, 'a tag beside a digest'],
    ['ghcr.io/acme/api@sha256:abc', 'a short digest'],
    ['api@' + digest, 'an image without a registry path'],
  ])('refuses %s (%s)', (reference) => {
    expect(parseImageReference(reference)).toBeNull();
  });

  it('accepts a registry image pinned by digest', () => {
    expect(parseImageReference('ghcr.io/acme/api@' + digest)).toEqual({
      image: 'ghcr.io/acme/api',
      digest,
    });
  });
});

describe('manifest against the registered release', () => {
  it('accepts a manifest that restates the release', () => {
    expect(manifestProblem(manifest, release)).toBeNull();
  });

  it.each([
    ['commitSha', { commitSha: 'c'.repeat(40) }],
    ['sourceEnvironmentId', { sourceEnvironmentId: release.projectId }],
    [
      'artifacts',
      {
        artifacts: [
          {
            slot: 'backend',
            image: 'ghcr.io/acme/api',
            digest: 'sha256:' + 'f'.repeat(64),
          },
        ],
      },
    ],
    ['workflowRun', { workflowRun: { ...release.workflowRun, runId: '43' } }],
    ['schemaVersion', { schemaVersion: 2 }],
    ['unknown field', { hostSecret: 'x' }],
    [
      'migrations',
      { migrations: [{ id: '1', checksum: 'md5:1', mode: 'expand' }] },
    ],
  ])('refuses a changed %s', (_field, change) => {
    expect(manifestProblem({ ...manifest, ...change }, release)).not.toBeNull();
  });
});
