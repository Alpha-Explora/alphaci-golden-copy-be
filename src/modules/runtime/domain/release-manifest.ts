import { createHash } from 'node:crypto';

/**
 * The signed on-prem release manifest (schema version 1). W2 builds and signs
 * it in CI; C1 checks it against the registered release and stores it; the
 * host verifies the signature with its pinned public key before pulling.
 * docs/architecture/onprem-release-manifest.schema.json is the published form.
 */
export type ReleaseSlot = 'backend' | 'frontend' | 'standalone';
export const RELEASE_SLOTS: readonly ReleaseSlot[] = [
  'backend',
  'frontend',
  'standalone',
];

export interface ReleaseArtifact {
  slot: ReleaseSlot;
  image: string;
  digest: string;
}

export interface WorkflowRun {
  provider: 'github_actions';
  repo: string;
  runId: string;
  url: string;
}

export interface ReleaseMigration {
  id: string;
  checksum: string;
  mode: 'expand' | 'contract';
}

export interface ReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  projectId: string;
  sourceEnvironmentId: string;
  sourceBranch: string;
  commitSha: string;
  createdAt: string;
  artifacts: ReleaseArtifact[];
  migrations?: ReleaseMigration[];
  workflowRun: WorkflowRun;
}

/** The registered facts a manifest must restate exactly. */
export interface RegisteredReleaseFacts {
  releaseId: string;
  projectId: string;
  sourceEnvironmentId: string;
  sourceBranch: string;
  commitSha: string;
  artifacts: ReleaseArtifact[];
  workflowRun: WorkflowRun;
}

/** Signature algorithms a host verifier accepts (Cloud KMS EC_SIGN_P256_SHA256). */
export const SIGNATURE_ALGORITHMS = ['ecdsa-p256-sha256'] as const;

export const COMMIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

/**
 * Split an `image@sha256:<64 hex>` reference. Tags, including a tag next to a
 * digest, are refused: a release names exactly one immutable image.
 */
export function parseImageReference(
  reference: string,
): { image: string; digest: string } | null {
  const at = reference.indexOf('@');
  if (at <= 0) return null;
  const image = reference.slice(0, at);
  const digest = reference.slice(at + 1);
  if (!IMAGE.test(image) || !DIGEST.test(digest)) return null;
  return { image, digest };
}

/**
 * RFC 8785 JSON canonicalization for the values a manifest can hold: object
 * keys sorted by UTF-16 code units, no insignificant whitespace, ECMAScript
 * number serialization. Anything JSON cannot represent is refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot represent ' + String(value));
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, item]) => item === undefined)) {
      throw new TypeError('Canonical JSON cannot represent undefined');
    }
    return (
      '{' +
      entries
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
        .join(',') +
      '}'
    );
  }
  throw new TypeError('Canonical JSON cannot represent a ' + typeof value);
}

/** Lowercase hex SHA-256 of the canonical manifest; the value that is signed. */
export function manifestSha256(manifest: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(manifest), 'utf8')
    .digest('hex');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sameArtifacts = (left: ReleaseArtifact[], right: ReleaseArtifact[]) => {
  const key = (artifact: ReleaseArtifact) =>
    artifact.slot + ' ' + artifact.image + '@' + artifact.digest;
  return (
    left.length === right.length &&
    left.map(key).sort().join('\n') === right.map(key).sort().join('\n')
  );
};

/**
 * Why a submitted manifest cannot be accepted for this release, or null when
 * it is well formed and restates the registered release exactly.
 */
export function manifestProblem(
  manifest: unknown,
  release: RegisteredReleaseFacts,
): string | null {
  if (!isRecord(manifest)) return 'manifest must be an object';
  const allowed = new Set([
    'schemaVersion',
    'releaseId',
    'projectId',
    'sourceEnvironmentId',
    'sourceBranch',
    'commitSha',
    'createdAt',
    'artifacts',
    'migrations',
    'workflowRun',
  ]);
  const unknownKey = Object.keys(manifest).find((key) => !allowed.has(key));
  if (unknownKey) return 'unknown manifest field ' + unknownKey;
  if (manifest['schemaVersion'] !== 1) return 'schemaVersion must be 1';

  for (const field of [
    'releaseId',
    'projectId',
    'sourceEnvironmentId',
    'sourceBranch',
    'commitSha',
  ] as const) {
    if (manifest[field] !== release[field]) {
      return field + ' does not match the registered release';
    }
  }
  const createdAt = manifest['createdAt'];
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    return 'createdAt must be an ISO 8601 timestamp';
  }

  const artifacts = manifest['artifacts'];
  if (
    !Array.isArray(artifacts) ||
    !artifacts.every(
      (artifact) =>
        isRecord(artifact) &&
        Object.keys(artifact).length === 3 &&
        RELEASE_SLOTS.includes(artifact['slot'] as ReleaseSlot) &&
        typeof artifact['image'] === 'string' &&
        typeof artifact['digest'] === 'string' &&
        parseImageReference(artifact['image'] + '@' + artifact['digest']) !==
          null,
    )
  ) {
    return 'artifacts must name each slot image by sha256 digest';
  }
  if (!sameArtifacts(artifacts as ReleaseArtifact[], release.artifacts)) {
    return 'artifacts do not match the registered release';
  }

  const migrations = manifest['migrations'];
  if (
    migrations !== undefined &&
    !(
      Array.isArray(migrations) &&
      migrations.every(
        (migration) =>
          isRecord(migration) &&
          Object.keys(migration).length === 3 &&
          typeof migration['id'] === 'string' &&
          migration['id'].length > 0 &&
          typeof migration['checksum'] === 'string' &&
          DIGEST.test(migration['checksum']) &&
          (migration['mode'] === 'expand' || migration['mode'] === 'contract'),
      )
    )
  ) {
    return 'migrations must list id, sha256 checksum, and expand or contract mode';
  }

  const run = manifest['workflowRun'];
  if (
    !isRecord(run) ||
    Object.keys(run).length !== 4 ||
    run['provider'] !== release.workflowRun.provider ||
    run['repo'] !== release.workflowRun.repo ||
    run['runId'] !== release.workflowRun.runId ||
    run['url'] !== release.workflowRun.url
  ) {
    return 'workflowRun does not match the registered release';
  }
  return null;
}
