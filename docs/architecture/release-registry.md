---
type: "Project Contract"
title: "Release registry"
description: "Immutable releases, signed on-prem manifests, explicit promotion, and the host polling contract."
tags: [runtime, releases, deployment, on-prem]
status: stable
sources:
  - id: "release-schema"
    resource: "supabase/migrations/runtime/20260928200000_release_registry.sql"
    title: "Release registry persistence"
  - id: "release-service"
    resource: "src/modules/runtime/application/release-registry.service.ts"
    title: "Release registration, promotion, and host rules"
  - id: "manifest"
    resource: "src/modules/runtime/domain/release-manifest.ts"
    title: "Manifest canonical form and checks"
  - id: "manifest-schema"
    resource: "docs/architecture/onprem-release-manifest-schema.json"
    title: "Manifest JSON Schema"
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
  environment's automatic deployment.

CI tokens can register, sign, read, and report their own project's releases.
They cannot promote, approve, or change what production runs.

## Promotion (signed-in session)

POST /projects/:projectId/environments/:environmentId/promotions with
`{releaseId}` deploys the release to that environment. It is refused unless:

- the environment is not the first one;
- the release has a signed manifest;
- the immediately preceding environment currently runs that release (its
  latest healthy deployment);
- every slot deployed by the source environment resolves to an active target
  on the destination (no fallback);
- the caller can change the project, and for the production environment is a
  workspace admin or delegated lead;
- the destination has no deployment in flight.

Deployment status moves pending → deploying → healthy, failed, or
rolled_back; it never moves backwards.

## On-prem hosts (host token)

Hosts stay unreachable until the deployment sets
`ONPREM_RELEASES_ENABLED=true`. A signed-in admin or delegated lead registers
a host for one environment with POST
/projects/:projectId/environments/:environmentId/hosts; the response holds
the only copy of the host token, and only its SHA-256 is stored.

- GET /onprem/assignments returns the host's environment's in-flight
  deployments whose release is signed: the assignment (project, destination
  environment, target IDs) and the envelope (manifest, manifest hash,
  signature).
- POST /onprem/deployments/:deploymentId/status reports progress for a
  deployment of the host's own environment.

The host verifies the signature with its pinned public key before pulling
any artifact. Neither the manifest nor the assignment carries host secrets.

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
