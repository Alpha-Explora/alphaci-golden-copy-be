# Directory Update Log

## 2026-09-15

- **Update**: Added deterministic provenance to the generated `@alphaci/capability-catalog` package. `provenance.json` binds the backend source digest and package identity to a canonical generated-file digest, and the package checker now rejects stale or tampered output.
- **Creation**: Made `catalog.source.json` the authoring source for composition (ADR-0010). One record now carries the capability, its pack membership, and its frontend surface, and the registry, manifests, pack rows, maps, and ledger entry are derived by `npm run capability:new`. The generated files stay checked in because the literal key union is what makes an unknown capability a compile error. Source validation rejects a dependency that is absent from a pack its dependant belongs to, which previously resolved to a capability that silently did not work.
- **Creation**: Added the capability ledger. The generated matrix says what the catalog contains; the ledger says when each key, maturity, dependency edge, configuration flag, or edition membership changed and under which record. The gate compares a composition hash rather than a Git diff, so an edit without an entry fails from the working tree alone, and the summary stays hand-written because a record derived from history can say what changed but not why. Description and wording edits do not move the hash and need no entry.
- **Creation**: Recorded client capability policies (ADR-0009). A client is not an edition; it is a deny-only policy that narrows one edition manifest for one deployment, so the Enterprise manifest becomes the union of what any Enterprise client may run and each client removes the remainder. Allowing a policy to enable a capability was rejected because the build profile would stop being a ceiling the compiled-artifact scan can describe.
- **Update**: Added the client policy port with a declared in-repository source and a deployment-supplied JSON source, selected by `ALPHACI_CLIENT` and `ALPHACI_CLIENT_CONFIG`. Selection fails closed on an unknown client, an unreadable or malformed document, an unknown field, an unknown capability key, a key outside the edition, or a policy declaring a different edition. A store-backed source can replace either without touching the resolver, the guard, or a controller.
- **Update**: Documented the composition variables in the environment reference and added `deploy/env` combinations for hosted SaaS, hosted EDU, Enterprise, and Enterprise dedicated to one client.
- **Update**: Narrowed the edition-branch rule in the documentation gate to comparisons against an edition literal in either operand order. Comparing two edition values remains allowed so a policy written for another edition can be rejected at boot; the rule still forbids the product branch it was written for.
- **Creation**: Promoted the real Enterprise client-policy composition path to the limited `runtime.client-composition` capability. The parser, registry, and source factory now live under `src/packs/enterprise` behind a profile-keyed loader; hosted output excludes the pack source and the frontend consumes the backend-owned API/configuration and artifact-symbol contract.

## 2026-09-11

- **Update**: Kept application services on the deployment-scoped resolver binding so Nest request scope stays at the HTTP boundary, and added a live guard-pipeline test for 404-before-Billing plus preserved Billing 402 behavior. Invalid `ALPHACI_EDITION` now fails closed while an unset value still defaults to Enterprise.
- **Update**: Kept request-scoped capability resolution at the HTTP boundary and added an explicit deployment-scoped resolver for background consumers. Platform outbox handlers therefore register during boot while request guards can still forward tenant subjects through the same composition contract.
- **Update**: Added the generated `@alphaci/capability-catalog` package artifact and parity gate. The frontend's local fixture can consume the public keys, maturity, edition membership, and dependency edges without reading a sibling checkout; package publication remains a separate release operation.
- **Update**: Added typed `hosted` and `enterprise` build profiles, boot-time profile/edition ceiling validation, and fail-closed profile-specific compiled-output exclusion scanning. The hosted profile excludes the Enterprise client-policy implementation root and symbol; `check:composition-profiles` compiles each profile in isolation and validates hosted SaaS, hosted EDU, and Enterprise resolution without writing the normal `dist` directory.
- **Update**: Classified optional provider and live-adapter toggles as explicit non-capability configuration flags. Base capabilities now resolve from their primary `*.enabled` flag, so local snapshot/history behavior remains available when an optional live mode is disabled.
- **Update**: Added the request-scoped composition resolver and static manifest-source seam. `ALPHACI_EDITION` now selects the deployment manifest, defaulting to Enterprise, and `/api/v1/capabilities` projects its resolved deployment set into the existing compatibility fields while exposing `edition` and `capabilityKeys`. The subject resolver path is wired for future tenant narrowing; licensing, persistence, and build profiles remain out of scope.
- **Update**: Moved capability catalog authority into the application kernel, with edition applicability declared by pack manifests. PR 1 adds a behavior-neutral pure resolver; no request endpoint or build artifact changed.
- **Update**: Added the kernel-owned `@RequiresCapability(...)` decorator and
  `CapabilityGuard`. The four runtime environment-provisioning controllers now
  resolve declared capabilities subject-scoped before Billing's subscription
  check, returning a generic 404 when composition is absent. No service-level
  enabled reads, tenant persistence, provider DTO behavior, or build artifact
  status changed.
- **Creation**: Recorded the runtime composition resolution decision (ADR-0007). Capability resolution moves into the kernel and narrows through build profile, edition manifest, deployment configuration and tenant override, with the `requires` closure applied last. Subscription entitlement is deliberately excluded from that chain: it answers whether a caller has bought access, not what the product offers, so it stays owned by Billing and runs after resolution. The composition check runs first so an unentitled caller cannot learn that an out-of-pack capability exists.
- **Creation**: Recorded the build profile and artifact exclusion decision (ADR-0008). A profile is a declared set of packs compiled into one artifact, which is what lets a hosted deployment carry SaaS and EDU and resolve the edition per tenant while an Enterprise artifact carries neither. Exclusion is derived from composition data and applied by build configuration, never by an edition comparison in source.
- **Update**: Linked ADR-0002 and ADR-0003 forward to the two new records rather than rewriting them. Both remain accurate accounts of what was decided at the time; ADR-0003 had already required any runtime pack-selection feature to be a separate decision, and ADR-0007 is that decision.
- **Update**: Moved the SaaS-to-Enterprise review out of `docs/architecture/`. It is a dated report naming local checkout paths, so it failed the bundle gate that canonical current-state documentation must pass, and it blocked every other documentation check.
- **Update**: Made the documentation bundle gate skip the `superpowers` directory, matching the frontend, so dated specs and plans stop being validated as canonical current-state documents.

- **Update**: Stopped the pipeline reporting a stage that never ran as a success. The stage conclusion was derived from `needs.*.result` by testing for `failure` and then `cancelled`, and `skipped` is neither, so a stage whose jobs all skipped fell through to the final `else`. Every `package` report the platform had ever stored — 24 of 24 — said `success` with an empty payload, while the quality stage gating it had never once passed, so not one of those successes described a build that happened. The stage now reports nothing when its work did not run. Where an earlier stage failed, that resolves on read as `blocked` against the stage that stopped it; where the gate passed and only the branch scope skipped the work, it reads as `pending`, which is imprecise but not the false success it replaces.
- **Update**: Made "did this stage run" read the stage's own work rather than any job in `needs`. `validate-access` is in every stage's `needs`, so a signal spanning all of them went true as soon as the gate passed — which also graded a pull request into `dev` a successful package, because `build` is branch-scoped and skips when the head branch is the PR branch. The package stage now reads `build`, and the quality stage reads its toolchain's checks, excluding the gate, the branch-policy job and the secret-gated Sonar job.
- **Creation**: Added the .NET secret, licence and SBOM quality slots, calling `gitleaks-scan.yml`, `dotnet-license-scan.yml` and `dotnet-sbom.yml`. All three key their strictness off the single `fail-on-warning` branch-policy output rather than inventing a per-gate policy, so a branch is not strict about licences and lax about secrets for reasons nobody remembers.
- **Update**: Gave the .NET scaffold the seam its test libraries need. `NSubstitute` and `NetArchTest.Rules` were declared as package references with nothing exercising them, and the architecture test as first written both failed to compile against a global-namespace `Program` and asserted over an empty type set, which NetArchTest reports as a pass. The scaffold now ships an `IServiceStatus` domain seam, a substituted-dependency test, and an architecture test guarded against a vacuous match.

## 2026-09-08

- **Update**: Gave frontend project types a default hosting target. A backend created without touching the wizard's hosting step got Render automatically; a frontend got nothing, so its pipeline built, tested and deployed nowhere. `vercel` was already named the default frontend provider but nothing read it.
- **Update**: Made the provisioning defaults port resolve by role rather than assuming backend, so both defaults come from one call and a provider that declares none returns undefined instead of throwing.

- **Creation**: Added `ToolchainFragment` and `ToolchainFragmentRegistry` in `kernel/ports`, mirroring the deployment provider contract, so the quality stage's stack-specific jobs resolve by lookup instead of an `isBackend` conditional.
- **Creation**: Added the Node toolchain fragment covering `nextjs`, `react`, `nestjs`, `nodejs`, `react-native` and `expo`, and moved the test, lint, typecheck and security jobs into it from the staged workflow builder.
- **Update**: Recorded the stack-as-a-declared-axis decision (ADR-0006) and the migration's verification result: 312 reachable bundle combinations byte-identical, with the 168 differing ones proven unreachable because `kind` is read from the catalog row the stack keys.
- **Update**: Made an unsupported stack raise instead of emitting a quality stage without its toolchain jobs, and made an _absent_ stack keep its previous classification, so the two cases stop sharing one silent default.
- **Update**: Named the access and branch-policy job ids so a fragment's `needs:` and the workflow's job keys cannot drift apart.
- **Creation**: Added the .NET toolchain fragment and registered `dotnet`, so the generator emits `dotnet-test`, `dotnet-format`, `dotnet-analyze` and `dotnet-audit` instead of the Node quality workflows.
- **Update**: Moved the package stage's `build` job into the toolchain contract. It was written against `setup-node` and `npm ci`, which a .NET repository has no answer for, and every provider deploy job depends on it.
- **Update**: Declared the runtime version per stack in the catalog. The generate DTO only carries `nodeVersion`, which would have asked `setup-dotnet` for an SDK numbered 24.
- **Update**: Taught `inferStack` to return `dotnet` and sourced the project-type `language` from the catalog, which was hardcoded to TypeScript for every stack.
- **Update**: Fixed the branch the promotion flow starts on. Provisioning created `develop` on every new repository while the generated pipelines listened on `dev`, so the dev tier never ran and `promote-to-uat` could never fire. Both halves now derive from one declaration in `kernel/config/pipeline-branches.ts`.
- **Creation**: Added a branch-model guard asserting that every branch the pipeline triggers on is a branch provisioning creates, that no generated trigger names a branch outside the flow, and that the working tier stays unprotected.
- **Creation**: Added the .NET standalone scaffold, so a .NET project can be created rather than only connected. Verified by generating the tree and running the pipeline it ships with: restore, a `-warnaserror` build, the tests, the coverage gate at 100%, `dotnet format --severity warn`, and the NuGet audit all pass.
- **Update**: Declared `serviceTemplate` and `repoShapes` per stack. The pipeline template was reconstructed from a hardcoded map plus a filename convention, so a new stack resolved to a template nobody had written; repo shapes were derived from `kind`, so a stack was offered shapes its scaffold could not build.
- **Update**: Returned `branchesCreated` from project creation and rendered it in the frontend, which had hardcoded `["main", "uat", "develop"]` and told users a branch was created that was not.
- **Update**: Made the generated README describe the stack it was generated for. It printed `npm install` for every stack and named `uat` as the first promotion target.

## 2026-09-03

- **Update**: Recorded that the frontend repository keeps a matching current-state bundle that snapshots this catalog.
- **Update**: Recorded pack-specific target capabilities as `not-implemented` registry keys, with `not-applicable` pack status when a pack does not include the capability.
- **Update**: Allowed empty `configurationFlags` on `not-implemented` records so absent product areas do not invent AppConfig flags.
- **Update**: Made the SaaS, EDU, and Enterprise pack profiles list every current registry capability in registry order, with status derived from maturity and edition applicability.
- **Update**: Added pack catalog completeness to `check:capabilities` so sampled or reordered pack tables fail the documentation gate.

## 2026-09-02

- **Update**: Bound the capability registry to real application configuration with `configurationFlags` and `requires`, so a renamed `AppConfig` flag can no longer leave the registry and generated matrix silently green.
- **Update**: Added the `check:capabilities` gate covering flag existence, two-way flag ownership, dependency resolution, acyclicity, and edition-narrowing of dependencies.
- **Update**: Pinned `*.txt` to LF so the generated route-inventory baseline hash is stable on Windows checkouts.

## 2026-09-01

- **Update**: Documented the current leased PostgreSQL outbox relay, explicit hierarchy sync mode, topic ownership, and recovery procedures.
- **Update**: Recorded provider-pack composition as the current Runtime boundary without changing provider behavior or public compatibility fields.
- **Update**: Added rollback-safety guidance for branch-scoped environment data and aligned the architecture references with the active migration and transaction behavior.
- **Update**: Tightened rollback preflight to reject any preview data whose branch identity cannot survive the legacy schema, and made outbox topic filtering fail closed for unregistered strings.

## 2026-08-28

- **Creation**: Established the current-state OKF v0.2 documentation bundle.
- **Update**: Added architecture, capability, pack, and operational navigation.
- **Update**: Added generated maps and repository validation for documentation drift.
- **Update**: Added the executive report with Enterprise-first priorities, parallel workstreams, delivery gates, and evidence requirements.
- **Update**: Reworked the executive report into plain language and added the relationship between detailed documentation, capabilities, packs, runbooks, evidence, and leadership reporting.
- **Update**: Made the executive report self-contained so readers can understand the current position and implementation approach without opening other documents.
- **Update**: Made the report context-independent and drop-in ready by putting the complete explanation, current status, pack relationship, priorities, and parallel delivery model in one document.
