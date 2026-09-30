# Changelog

## [Unreleased]

### Added

- Added ADR-0013 (QA verification runs): the `qa` persona derived from the `qa-team` GitHub team, workspace checklists shared to projects, runs keyed on project, checklist, branch and server-resolved commit with snapshotted items, persona-based item rights, server-enforced sign-off with a frozen `report_json`, run-row locking against concurrent edits, the `qa-report/v1` JSON and Markdown export, and automated CI results shown beside manual verdicts without changing them.
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

- Added `AGENTS.md` with testing, commit, and plan rules; added `npm run check` (static gates) and `npm run verify` (what CI runs); merged the two CI workflows into one with parallel static and test jobs and dropped duplicate steps. The documentation gate no longer requires a fixed file list, bans only session phrases, skips dated plans and reports, and no longer re-runs the capability gates. Retired `docs/log.md` in favor of this changelog and git history, removed the completed 2026-09-11 plans and spec, and moved the draft on-premises CI/CD report out of the architecture docs.
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
