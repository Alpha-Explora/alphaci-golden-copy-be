---
type: 'Project Contract'
title: 'Release registry'
description: 'Immutable releases, signed on-prem manifests, explicit promotion, and the host polling contract.'
tags: [runtime, releases, deployment, on-prem]
status: stable
sources:
  - id: 'release-schema'
    resource: 'supabase/migrations/runtime/20260928200000_release_registry.sql'
    title: 'Release registry persistence'
  - id: 'release-service'
    resource: 'src/modules/runtime/application/release-registry.service.ts'
    title: 'Release registration, promotion, and host rules'
  - id: 'active-host-schema'
    resource: 'supabase/migrations/runtime/20261015010000_one_active_onprem_host.sql'
    title: 'One active host registration per environment'
  - id: 'manifest'
    resource: 'src/modules/runtime/domain/release-manifest.ts'
    title: 'Manifest canonical form and checks'
  - id: 'manifest-signature'
    resource: 'src/modules/runtime/domain/release-signature.ts'
    title: 'Trusted release signature verification'
  - id: 'manifest-schema'
    resource: 'docs/architecture/onprem-release-manifest-schema.json'
    title: 'Manifest JSON Schema'
---

# Release registry

A release is registered once by CI for a project's first environment, and its
identity never changes: project, source environment, source branch, full
40-character commit SHA, per-slot container artifacts, and the workflow run
that built it. The first environment is the only one that deploys
automatically; registration records that deployment. Every later environment
receives a release only through an explicit, signed-in promotion.

Release verification (a signed manifest) and each environment's deployment
state are separate records. Database triggers refuse any change to a
release's identity or artifacts, and to a verified release's manifest.

## CI routes (project CI token)

- POST /ci/releases with `sourceEnvironmentId` registers a release. The source
  must be the first environment and `sourceBranch` its source branch; the
  workflow run must belong to the authorized repository; each artifact is
  `image@sha256:<64 hex>` and floating tags are refused; every artifact slot
  must have an active target on the first environment. One release per
  workflow run; one deployment in flight per environment. A body without
  `sourceEnvironmentId` is the legacy branch release request and keeps its
  previous behavior.
- GET /ci/releases/:releaseId reads a registered release (UUID IDs) or a legacy
  `<targetId>.<providerReleaseId>` release.
- PUT /ci/releases/:releaseId/manifest attaches the manifest CI signed. The
  backend recomputes the canonical hash and refuses a manifest that does not
  restate the release exactly, a hash that does not match, or an unsupported
  signature algorithm. Resubmitting the same signed manifest is accepted; a
  different one is refused.
- POST /ci/releases/:releaseId/deployment-status reports the first
  environment's automatic deployment. For host delivery, CI may report only
  `failed` while the release is unsigned and its automatic deployment is
  pending; repeating that cleanup is accepted. CI cannot report a signed
  host deployment's outcome. Signing and cleanup serialize on the release
  row: a late signature after cleanup is rejected, and a retry registers a
  release from a new workflow run.

CI tokens can register, sign, read, and report their own project's releases.
They cannot promote, approve, or change what production runs.

- POST /ci/deployments/:deploymentId/status reports a promoted deployment
  that the generated promotion workflow runs for its own project.

## Promotion (signed-in session)

POST /projects/:projectId/environments/:environmentId/promotions with
`{releaseId}` deploys the release to that environment. It is refused unless:

- the environment is not the first one;
- the release has a signed manifest;
- the immediately preceding environment currently runs that release (its
  latest healthy deployment);
- every slot deployed by the source environment resolves to an active target
  on the destination (no fallback);
- the caller can see the project and has an allowed global app persona:
  admins and leads may promote to any environment; Developers (`member`) may
  promote to non-production environments only; QA, unresolved roles, and
  other personas are refused;
- the destination has no deployment in flight.

Deployment status moves pending → deploying → healthy, failed, or
rolled_back; it never moves backwards.

Signed-in users who can see a project also read GET
/projects/:projectId/releases (its releases, newest first, each with its
deployments) and GET /projects/:projectId/environments/:environmentId/deployments
(that environment's deployment history, newest first).

When every destination target is a managed provider (Render or Vercel),
AlphaCI starts the repository's generated `30-alphaci-promote.yml` workflow on
the release's source branch with the release, deployment, and environment
IDs. If GitHub refuses the dispatch, the deployment is marked failed, so the
promotion can be retried.

## Generated pipelines

A project generated with environments gets its triggers from them. Access
and quality run on every distinct source branch. The package stage builds
and deploys only the first environment, on a push to its branch: it builds
each container image once, registers the release, has it signed by the
central `sign-release.yml` workflow, deploys it to the first environment's
targets, and reports the result. A push to a later environment's branch runs
the checks and deploys nothing. The promotion workflow deploys a release to
the one later environment it was dispatched for, using the release's pinned
commit and image digests, and reports the result. Every deploy job names its
environment ID, GitHub Environment, and target ID; none is chosen from the
branch. Projects without environments keep the fixed `dev → uat → main`
pipeline.

For a host-delivered first environment, signing failure or cancellation runs
the generated cleanup job to fail its unsigned pending deployment and free
the environment for a later release. Existing project workflows must be
regenerated to gain this job. If it cannot run, the same CI status endpoint
allows explicit cleanup. Package stage results include the signing job.

## On-prem hosts (host token)

Hosts stay unreachable until the deployment sets
`ONPREM_RELEASES_ENABLED=true`. A signed-in Developer (`member`) or admin
registers a host for one environment with POST
/projects/:projectId/environments/:environmentId/hosts; the response holds
the only copy of the host token, and only its SHA-256 is stored.

Each environment has one active registration. Registering a replacement
atomically revokes all its previous tokens; simultaneous registrations
serialize per environment. Other environments and projects retain their
tokens. The migration keeps the newest active registration when upgrading
legacy duplicates, and rolling back its unique index does not reactivate
revoked credentials. Stop the old agent before replacement: revocation
refuses future requests but cannot stop Docker commands already running.

- GET /onprem/assignments returns the host's environment's in-flight
  deployments whose release is signed: the assignment (project, destination
  environment, target IDs) and the envelope (manifest, manifest hash,
  signature).
- POST /onprem/deployments/:deploymentId/status reports progress for a
  deployment of the host's own environment.

The host verifies the signature with its pinned public key before pulling
any artifact. Neither the manifest nor the assignment carries host secrets.

The agent waits for Compose services on deployment and restoration. When
`ALPHACI_HEALTH_URL` is configured, that URL must also answer successfully
after both operations. A rollback reports `rolled_back` only if restoration
and these checks pass; otherwise it reports `failed`. With the URL unset,
health is limited to Compose's wait result and the services' own healthchecks;
it does not verify an application HTTP endpoint.

## Manifest

The signed payload is the canonical JSON (RFC 8785) of the manifest described
by [the manifest JSON Schema](onprem-release-manifest-schema.json):
`schemaVersion` (1), `releaseId`, `projectId`, `sourceEnvironmentId`,
`sourceBranch`, full `commitSha`, `createdAt`, `artifacts[{slot, image,
digest}]`, optional `migrations[{id, checksum, mode}]`, and
`workflowRun{provider, repo, runId, url}`. The envelope adds `manifestSha256`,
the lowercase hex SHA-256 of those canonical bytes, and
`signature{algorithm, keyId, value}`; `ecdsa-p256-sha256` (Cloud KMS
`EC_SIGN_P256_SHA256`) is the accepted algorithm. Vercel slots carry no
artifact: Vercel builds from the pinned commit and records its own deployment
ID.

AlphaCI verifies the signature over the exact canonical manifest bytes before
it marks a release verified or allows promotion. Configure
`ALPHACI_RELEASE_TRUST_KEYS_JSON` as a JSON object from key ID to PEM public
key. For example:

```json
{
  "projects/alphaci/keys/release/1": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----\\n"
}
```

The setting may contain multiple key IDs during key rotation. Missing or
unknown keys and invalid signatures are rejected; malformed trust
configuration fails closed. The host still verifies the same signature with
its locally pinned key before pulling images, so its trust check does not
depend on AlphaCI's API response.
