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

## Workspace machines and environment assignments

Runtime owns `onprem_workspace_lifecycle`, `onprem_machines`, `onprem_enrollments`,
and `onprem_port_reservations`. Apply migrations `20261015020000` and
`20261015030000` after `20261015010000`, then `20261016010000`, before activating
this version. RLS and
explicit revokes deny direct `anon` and `authenticated` access. HTTP requests use
the existing workspace visibility, application hosting role, and subscription gates.

- `GET /workspaces/:workspaceId/onprem-hosts` lists machines and pending enrollment.
- `POST /workspaces/:workspaceId/onprem-host-enrollments` accepts name, platform,
  request UUID, and optional explicit replacement machine ID. It returns a
  256-bit code once, expiring after ten minutes, the public API URL, and a pinned
  installer version/HTTPS URL/SHA-256. Storage receives only the code hash.
- `POST /onprem/enroll` consumes that code transactionally and returns one
  `onprem_machine_` credential plus public verification keys. A lost response
  cannot replay credentials. Issue a new enrollment or explicit replacement.
- `POST /onprem/heartbeat` uses the machine bearer credential and reports agent
  version and prerequisite checks. A check-in older than 90 seconds is offline.
  Heartbeat, assignment polling, and status reports are limited to 120 requests
  per minute per machine credential, and to 300 per minute per client address
  for requests that need a credential lookup.
- `POST /workspaces/:workspaceId/onprem-hosts/:machineId/revoke` stops new
  authorized work and ends the machine's bindings in the same transaction,
  releasing their host ports. A named replacement takes the bindings over
  instead. Revocation without a replacement also expires the machine's pending
  replacement enrollments, so their codes stop working. It cannot stop offline
  containers or erase host data.
- `GET`, `POST`, and `DELETE /projects/:projectId/environments/:environmentId/host-assignment`
  read, explicitly assign/replace, and unassign. POST takes machine ID, request
  UUID, expected current assignment ID or null, ports, health paths, and ingress.
  DELETE requires the expected current assignment ID. Stale comparisons return
  409. Identical POST request replays reuse the active assignment. Reads expose
  a legacy binding with null machine/config so it can be explicitly replaced.

One active host binding remains allowed per environment. Legacy registration
cannot silently revoke a machine binding. Assignment transactions lock the
machine, environment advisory key, and binding; reserve machine host ports;
and roll back both replacement and reservations on a conflict. Assignment reads
hold credential and binding locks through release selection. Status writes
recheck the live credential and exact project/environment binding in the same
transaction. Revocation either follows an authorized operation's commit or
causes that operation to fail. Workspace deletion revokes machines and expires
codes before deleting Identity's workspace; cleanup failure aborts deletion.

Production assignment requires explicitly configured HTTPS ingress. Each target
slot has a container port, a distinct machine host port, and a health path or
explicit null. Null records missing health evidence; the agent reports the
deployment failed without pulling or applying it until health is configured.
Readiness distinguishes missing schema, offline/revoked machines, prerequisites,
missing health paths, and still-unverified runner, registry, port, ingress, and
application checks. Connected does not mean application healthy.

Machine migration rollback revokes credentials and expires codes while retaining
their history. Reapplying cannot reactivate them. Assignment rollback refuses
active machine bindings and retains revoked history. Unassign first, then create
explicit legacy registrations if downgrading. SQL never runs at application startup.

`GET /onprem/installer/:version` serves only the configured archive whose bytes
match `ONPREM_INSTALLER_SHA256`. Operator configuration also sets
`ONPREM_INSTALLER_VERSION`, `ONPREM_INSTALLER_URL`, and `ONPREM_INSTALLER_PATH`.
When the explicit URL is unset, `ONPREM_INSTALLER_RELEASE_REPO` (owner/repo)
names a GitHub release tagged `onprem-agent-v<version>`. With
`ONPREM_INSTALLER_SHA256` set, that hash is the pin: the archive is fetched from
its release download URL, and enrollment proceeds only if its bytes match the
pin. Without a pin, the hash comes from the release's `installer-release.json`,
and the release must be marked immutable. Verified results are cached for ten
minutes and served for up to a day during transient GitHub errors. If the
archive cannot be verified, no enrollment code is issued.
The packaging command is `node scripts/package-onprem-agent.mjs`; it creates a
local archive and checksum manifest. The `On-prem agent release` workflow
(`.github/workflows/onprem-agent-release.yml`) publishes those files as release
assets when a matching tag is pushed.

Optional project creation host bindings use the kernel `OnpremAssignmentPort`
after project creation succeeds. Failures return `hostAssignments` or
`hostAssignmentError` alongside the created project. Retry assignment through
Hosting rather than submitting project creation again.

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

## Deployment history

`GET /projects/:projectId/environments/:environmentId/onprem-readiness`
requires normal session authentication, subscription/capability access, and
project visibility. It returns separate `checks[{id,status,message}]`, with
status `passed`, `failed`, or `unverified`. It inspects schema objects and
the validity/uniqueness of the active-host index without applying migrations.
API URL configuration, actual runner reachability, public signing trust,
CI signing-secret access, registry pull access, and host state have separate
results. Unavailable secret inspection remains unverified.

Generated GitHub-hosted jobs reject loopback/private API addresses before
authorization. Configure `PLATFORM_PUBLIC_URL` with the reachable HTTPS base
URL and regenerate workflows when it changes. Workflow previews restore
persisted environments and targets, including host delivery and image signing.
Local browser OAuth callback settings remain independent.

Runtime provider packs may contribute an AlphaCI-owned history source. The
on-prem source reads environment deployments joined to their immutable
release identity, restricted by project, the target's environment, and the
deployment's target IDs. Hosted providers retain authenticated provider API
history. Empty registry history is a successful live result; query failures
report unavailable history. A rolled-back attempt remains failed history,
even when the prior release was restored successfully.

## Signed manifest

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
