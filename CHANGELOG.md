# Changelog

## [Unreleased]

### Added

- Added the Windows side of on-prem hosts in `deploy/onprem/windows`. `Install-AlphaCIHost.ps1` (safe to rerun) registers two tasks: one runs as the account that owns the WSL distro, not elevated, and keeps it running at startup; the other runs as SYSTEM every minute and points the `netsh portproxy` rule for each port at the distro's current address. It also allows inbound traffic only from the client's subnets. `Uninstall-AlphaCIHost.ps1` removes all three without touching the distro, and `Export-AlphaCIHostSupport.ps1` collects a support zip. `alphaci-agent support-bundle` writes the Linux-side archive with secret values redacted and never reads the host token. `deploy/onprem/compose` adds an example Compose stack with Caddy terminating TLS with the client's certificate.

- Added the `onprem-compose` deployment provider, available when `ONPREM_RELEASES_ENABLED=true`. An on-prem target is a `byo` record in a project environment with no provider or GitHub call. Each deployment now records whether its workflow or its environment's host delivers it: promotions to an on-prem environment dispatch no workflow, CI tokens cannot report a host's deployment, hosts see and report only their own, and an environment cannot mix on-prem and hosted targets. Project creation accepts `environmentSlug` on a target to give one environment its own provider, so test and UAT can run on Render and Vercel while production runs on a host, and the package workflow builds every image a later environment's host will pull. Migration `20260928210000_onprem_compose_provider` widens the target provider check and adds `environment_deployments.delivery`.

- Added the on-prem host agent (`deploy/onprem/agent`): a bash poll cycle run by a systemd timer that fetches this host's assignments, verifies each manifest's canonical hash and ECDSA P-256 signature against the pinned public key before pulling, refuses artifacts not pinned by digest, pulls by digest, applies Compose, checks health, reports status, and restores the previous release when the new one fails. `install.sh` installs it on Ubuntu or WSL.

- Added project creation with environments for single-repository projects: the ordered `environments` list is stored, each distinct source branch is created once, every branch but the first environment's is protected, each environment gets its own target and GitHub Environment, and the generated pipeline names them. Other repository shapes still reject an `environments` list before any write. Workflow files for new repositories are pushed through the GitHub port.

- Added signed-in release history: `GET /projects/:projectId/releases` and `GET /projects/:projectId/environments/:environmentId/deployments`, for the environment operations view.

- Added pipelines generated from project environments. With environments configured, access and quality run on every distinct source branch, only the first environment builds, registers, signs, and deploys on push, and the new `30-alphaci-promote.yml` deploys a registered release's pinned commit and image digests to the one later environment it is dispatched for. Promoting to a Render or Vercel destination now dispatches that workflow, marking the deployment failed if GitHub refuses, and `POST /ci/deployments/:id/status` lets it report the promoted deployment. Projects without environments keep their fixed pipeline.

- Added the release registry. CI registers an immutable release (full commit SHA, per-slot `image@sha256` artifacts, workflow run) for the project's first environment with `POST /ci/releases` and `sourceEnvironmentId`, attaches its signed manifest with `PUT /ci/releases/:id/manifest` (canonical RFC 8785 hash recomputed and checked), and reports the first environment's automatic deployment. Signed-in users promote a verified release to the next environment only when the preceding environment runs it and every destination target resolves; production promotion needs an admin or delegated lead. On-prem hosts, off unless `ONPREM_RELEASES_ENABLED=true`, poll `GET /onprem/assignments` and report status with an environment-scoped host token. The legacy branch release request is unchanged. The manifest JSON Schema is in `docs/architecture/onprem-release-manifest-schema.json`.

- Added deployment targets keyed by project environment. A target created with `environmentId` deploys that environment's source branch, and each environment holds at most one target per slot, so two environments on one branch keep separate targets, env vars, and domains. `PUT .../deployment-targets/:targetId/environment` attaches a legacy target without changing its ID, `GET .../environments/:environmentId/deployment-targets/:slot` returns an environment's target or refuses an absent or failed one, and the repository's GitHub Environment is provisioned and limited to the source branch before any target is created or attached. The migration attaches only unambiguous legacy targets.

- Added the E2E suite (`npm run test:e2e`). It boots the real application and HTTP middleware against a disposable loopback PostgreSQL database with every migration applied, replaces only external provider ports with recording fakes, and writes `artifacts/e2e/<commit>/report.json`. CI runs it in a new `E2E` job. The first scenarios cover the project environments API and migration. `ALPHACI_IGNORE_ENV_FILE=true` makes the app skip `.env` files, and `configureHttpApplication` installs the production middleware on an app built elsewhere.

- Added project-owned ordered environments with stable IDs and slugs, append-only creation, display-name edits, session authorization, and a conservative legacy backfill. Projects without an unambiguous single production branch keep their legacy branch-based deployment path.

- Added proposed ADR-0012 (configurable deployment targets) and a consolidated on-premises setup plan. Customer projects can choose a provider per slot and branch: the first planned mix uses Vercel/Render for `dev` (test) and `uat`, then customer-hosted `onprem-compose` for `main`. AlphaCI platform hosting stays managed in this delivery; `onprem-k8s` and self-managed platform hosting are later options. The plan replaces the Kubernetes-only on-premises report and diagram.
- Added Render-parity deployment logs: `queryLogs` on the provider port (windowed, filterable by level/type/text/instance, paginated), fixing the Render client's old bug of reading a nonexistent top-level `l.level` field instead of the `labels` array. `GET .../deployment-targets/:targetId/logs` now returns `{ source, logs, hasMore, next, filters }`, where `source: 'unavailable'` (with no lines) replaces silently falling back to mock data on a live provider failure — mock data is now reserved for local-mock mode (`deploymentHistory.liveProvidersEnabled=false`). Added `GET .../logs/stream?mode=append` for an SSE live tail that sends one snapshot then only new lines per poll, capped at 5 provider pages per tick.
- Added the limited Enterprise-only `runtime.client-composition` capability, including the profile-keyed `src/packs/enterprise` client-policy pack, backend-owned `clientComposition` projection, and frontend artifact-symbol exclusion contract.
- Added focused pack-loader, static-import boundary, API projection, and profile artifact tests proving hosted compilation/runtime do not include the Enterprise implementation while Enterprise does.
- Added deterministic `provenance.json` generation for `@alphaci/capability-catalog`, including the catalog source digest and canonical package artifact digest, with checker coverage for stale and tampered output.
- Added `src/kernel/composition/catalog.source.json` as the single authoring source for composition, with `generate:composition`, the `check:composition-source` drift gate, and `capability:new`, which derives the registry, manifests, three pack rows, generated maps, and a ledger entry from one record.
- Added the capability ledger: an append-only `docs/capabilities/ledger.json`, a generated ledger map, the `check:capability-ledger` gate, and `ledger:record`. The gate recomputes a composition hash over every capability key, maturity, dependency edge, configuration flag, and edition membership, and rejects a catalog that moved without an entry.
- Added client capability policies. `ALPHACI_CLIENT` selects a policy owned by the Enterprise pack and `ALPHACI_CLIENT_CONFIG` mounts a deployment-supplied document; a policy is deny-only, validated at boot, and narrows the edition manifest on both the deployment and subject paths.
- Added ready-made composition environment files under `deploy/env` for hosted SaaS, hosted EDU, Enterprise, and Enterprise dedicated to a single client, plus an example client policy document.
- Added the generated `@alphaci/capability-catalog` package artifact and `check:capability-package` parity gate for the cross-repository capability contract.
- Added a deployment-scoped resolver binding for boot-time/background consumers while keeping the subject-scoped resolver request-scoped for HTTP composition checks.
- Added the request-scoped composition resolver, static manifest-source seam, and `CompositionModule`; `ALPHACI_EDITION` selects the deployment manifest and defaults to Enterprise.
- Added the kernel-owned `@RequiresCapability(...)` decorator and `CapabilityGuard`, with focused tests for metadata, subject forwarding, generic 404 handling, and guard order.
- Added the `check:capabilities` gate, which binds the application capability registry and manifests to the boolean leaves of `AppConfig` and validates capability dependency edges.
- Added an OKF v0.2 current-state documentation bundle covering architecture, capabilities, composition packs, runbooks, and change history.
- Added generated context, event, provider, route, schema, architecture-check, and capability maps.
- Added repository checks for OKF structure, lower-kebab documentation names, stale plan-specific claims, edition branches, and generated-map drift.
- Added an executive Golden Copy report covering Enterprise-first priorities, parallel implementation workstreams, delivery gates, and evidence requirements.
- Clarified the executive report in plain language, including how the detailed documentation connects to capabilities, packs, runbooks, evidence, and leadership reporting.
- Made the executive report self-contained by including the necessary current-state, pack, capability, operating, and evidence summaries.
- Made the executive report context-independent and drop-in ready by including its complete explanation, status, priorities, and parallel delivery model.
- Added ADR-0007, recording that capability composition resolves at runtime in the kernel, and that subscription entitlement stays a separate Billing decision applied after resolution.
- Added ADR-0008, recording build profiles as declared pack sets whose artifacts exclude source for packs they do not contain.
- Added ADR-0009, recording client capability policies as a deny-only layer between the edition manifest and deployment configuration.
- Added ADR-0010, recording one authoring record per capability with the registry, manifests, and pack rows generated from it.
- Made `capability-registry.ts` and `manifests.ts` generated files. They stay checked in so the literal key union keeps an unknown capability a compile error, and the drift gate rejects a hand edit.
- Narrowed the documentation gate's edition-branch rule to comparisons against an edition literal, in either operand order. Comparing two edition values to each other stays allowed, which is how a client policy written for another edition is rejected.
- Added typed hosted/Enterprise build profiles, boot-time profile ceiling validation, fail-closed profile-specific compiled-output exclusion scanning, and the isolated `check:composition-profiles` conformance command. The hosted profile now excludes the Enterprise client-policy implementation root and symbol.
- Added a deployment-scoped resolver boundary for singleton application services, live guard-pipeline coverage for composition-before-Billing behavior, and fail-closed validation for unknown `ALPHACI_EDITION` values.

### Changed

- Classified optional provider and live-adapter mode toggles as explicit non-capability flags so the resolver gates base capabilities only on their primary enablement flags.
- Changed `/api/v1/capabilities` to project its resolved deployment set into the existing compatibility fields and expose top-level `edition` and `capabilityKeys`, preserving the legacy nested response for the default fixture.
- Changed the deployment-targets, provider-connections, env-vars, and custom-domains controllers to enforce `runtime.env-provisioning` through `CapabilityGuard` before `SubscriptionGuard`; removed the obsolete `EnvFeatureGuard`.
- Moved capability catalog authority into the application kernel and declared edition applicability through manifests; PR 1 adds a behavior-neutral pure resolver without changing a request endpoint or build artifact.
- Made the SaaS, EDU, and Enterprise pack profiles list every shared capability in registry order, with status derived from the capability registry rather than sampled per pack.
- Recorded that the frontend repository keeps a matching current-state Golden Copy bundle that snapshots this catalog.
- Recorded SaaS, EDU, and Enterprise target gaps as `not-implemented` capability keys, and added pack status `not-applicable` for keys outside a pack.
- Extended `check:capabilities` to reject pack tables that omit, reorder, or restate capability status outside the shared catalog rule, and to forbid AppConfig flags on `not-implemented` records.
- Replaced obsolete architecture and operational document locations with current lower-kebab canonical paths.
- Synchronized the npm lockfile with the existing `js-yaml` dependency so clean `npm ci` installation succeeds.
- Kept the existing HTTP route inventory, public DTO compatibility, and product workflow behavior while tightening internal delivery and composition boundaries.
- Composed Runtime provider contributions through validated provider packs, retaining the current Render, Vercel, and GCP registrations and compatibility fields.
- Changed the PostgreSQL outbox relay to claim rows with short leases, release the database transaction before handler I/O, and acknowledge only the matching claim.
- Made hierarchy member offboarding and revoke-event publication share one transaction, so a failed enqueue rolls back the member and assignment changes together.
- Made the scheduled hierarchy relay require an explicit `live` or `stub` mode instead of relying on an implicit deployment default.
- Updated the outbox reliability migration, topic quarantine migration, and rollback procedures to document the active schema and recovery behavior.
- Linked ADR-0002 and ADR-0003 forward to the composition decisions instead of rewriting their original narrowing statements.
- Moved the SaaS-to-Enterprise review out of the canonical documentation bundle, and made the bundle gate skip the `superpowers` directory.

### Fixed

- Fixed the architecture route-inventory check failing on Windows checkouts by pinning `*.txt` to LF, so the committed baseline hash matches the working tree.
- Corrected outbox acknowledgement to update the active `published_at` column rather than the removed legacy `processed_at` column.
- Added fail-closed protection to the branch-scoped environment rollback so it cannot silently discard preview branch identity in the legacy schema.
- Preserved hierarchy failure context when GitHub repository or user resolution fails, allowing retry and audit handling to retain the group and acting-user context.

### Verification

- Documentation verification: `npm run check:documentation` (includes `npm run check:capabilities`).
- Full local verification: see [the local verification runbook](docs/runbooks/runbook-local-verification.md).
