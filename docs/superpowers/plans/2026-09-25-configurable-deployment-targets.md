# Configurable customer environments and deployment targets

**Goal:** Let each customer project define its own ordered environments and
choose a deployment provider for each frontend/backend target. The first
example uses Vercel/Render for test and UAT, then a customer-hosted Compose
target for production, without hand-editing generated workflows. Decision:
[ADR-0012](../../architecture/decisions/adr-0012-configurable-deployment-targets.md).
The [host setup guide](2026-09-25-onprem-client-setup-guide.md) holds the
installation and enterprise-client checklist.

## Local integration on 2026-10-14

The current FE, BE, and central workflow implementation is on local branches
named `codex/onprem-integration-20261014`, integrated with their latest fetched
main branches. Earlier checklists below record the original implementation;
this section describes the current integration. No remote branch or release
tag was changed and no shared database migration was applied.

- Backend: environment CRUD, scoped deployment targets, immutable releases,
  explicit promotion, trusted-key signature verification, host registration,
  outbound assignment polling, deployment status, and Compose agent rollback.
- Frontend: Hosting environment cards can add an on-prem target per available
  slot, register a host, show its one-time token, and promote releases with the
  current persona permissions and a second confirmation for production.
- Workflow: builds publish digest-pinned images; signing supports Cloud KMS
  and a lab PEM key; Render/Vercel deployments use explicit environment targets.
  A stale generated promotion workflow refuses mismatched recorded target IDs.
- Project provisioning publishes the generated workflows before considering
  the project complete, and uses the current audited branch-protection policy.

Local tests use a disposable loopback PostgreSQL database. Provider APIs are
recording fakes; the Linux host-agent tests run the actual shell/signature and
rollback logic with a Docker command shim. These tests do not prove a client
Windows reboot, GHCR pull permissions, production KMS access, or real customer
application health. The host setup guide remains the acceptance procedure for
those checks.

Verification of the integrated tree: backend typecheck, build, lint, architecture
boundaries, schema ownership, capabilities, composition source, capability
ledger, and documentation checks passed. Backend unit/architecture suite:
3,818 passed, 41 skipped; on-prem API/migration/host-agent suite: 63 passed.
Frontend typecheck, touched-file lint, architecture/documentation checks and
6 focused tests passed. Browser verification could not reach an authenticated
backend at localhost:4000 and remains incomplete. The central workflow's CI
selected actionlint list and canonical/signing-related contract checks passed;
a broader scan still reports existing findings in unrelated workflows.

For a deployed pilot, publish and pin a reviewed central-workflow revision
containing `sign-release.yml` before opting a project into this flow. The
currently published `v1` does not contain that workflow. Apply the additive
migrations, configure the signing public key trust map on the backend and the
matching PEM on the host, then enable `ONPREM_RELEASES_ENABLED`. Configure
KMS workload identity and repository variables (or a lab-only signing secret),
GHCR read access, host token, Compose file, health checks, DNS, and TLS. Run the
setup guide's pull, failed-health rollback, reconnect, and reboot checks before
calling a customer installation ready.

## Environment and deployment contract

| Example environment | Source branch | Role | Frontend slot | Backend slot |
|---|---|---|---|---|
| `dev` | `dev` | Test | Vercel preview | Render test service |
| `uat` | `uat` | UAT | Vercel preview | Render UAT service |
| `main` | `main` | Production | `onprem-compose` | `onprem-compose` |

This table is an **editable starting template**, not a fixed pipeline. Each
project owns an ordered set of environments with a stable ID, immutable slug,
editable display name, explicit source branch, and role. Exactly one environment
has the production role. Several environments may name the same source branch;
provisioning creates each distinct branch once. Only a push to the project's
first environment can start a release and auto-deploy its pinned commit.
Pushes to later environments' branches may run quality checks, but cannot
deploy or replace that release. Every later environment requires an explicit
release-promotion action in AlphaCI, which checks evidence for the pinned
commit. Branch promotion PRs remain an optional source-control policy; they do
not themselves deploy or rebuild a release.

Each `(project, environment ID, slot)` has at most one configured provider,
regardless of health status. The source branch is not the target identity. A
missing or failed target cannot fall back to another provider. Secrets, status,
URLs, approvals, and release history belong to the environment ID and target,
so two environments may safely share a branch. Additions and display-name
edits are supported first. Changing a live environment's branch, order,
production role, or identity, or deleting it, requires a separate migration
flow with explicit handling of its targets and secrets.

The release records an immutable source commit and per-slot artifact identity.
Render and Compose targets promote the **same GHCR image digest**. Vercel is a
documented provider exception: each configured environment builds from the
same pinned commit, and AlphaCI records its distinct Vercel deployment ID.
The workflow must not claim byte-for-byte artifact promotion between Vercel
preview/custom environments. Quality gates stay shared; packaging and deploy
jobs follow the selected provider. The on-prem host pulls by digest from a
signed release manifest; CI holds no host credentials.

Existing projects retain their present branches, targets, and deployment
behavior. An additive migration records their effective environment identities
without silently adding paid `dev` services or changing their providers.
New projects see the editable example above. Before generated workflows name a
GitHub Environment, provision and configure it explicitly; GitHub can otherwise
create an unprotected environment on first workflow use.

This first delivery covers **customer applications**. AlphaCI platform hosting
stays managed. `onprem-k8s` and self-managed AlphaCI platform hosting remain
proposed in ADR-0012 for later work. AlphaCI platform database deployment is
outside this plan; customer application targets do not move AlphaCI's database
to the customer host.

## Current state

- [x] The Ubuntu WSL2 laptop has its own Docker Engine, Compose, Buildx, Cosign, and the `/opt/alphaci` directories. The setup guide records the 2026-09-25 checks; the release workflow and host acceptance were not exercised in this refresh.
- [ ] The setup guide's recorded next host inputs are the signing public key, TLS files, GHCR pull credential, agent token, and application secrets. Recheck the machine before the host-agent phase.
- [ ] On current `main`, managed `uat`/`main` deployment assumptions remain. The on-prem provider, host agent, and mixed deployment activation are not merged; `dev` is not hosted.
- [ ] All feature commits below are local. No branches were pushed and no PRs were opened or merged.
- [x] The three temporary rollout branches were created locally on 2026-10-05 from the last fetched `origin/main` refs: backend `24760fc` (E1 and R1), frontend `90fb9cb` (F1 and F2), and workflow `827c860` (W1 and W2). The original feature branch refs remain intact. A live remote-head check was blocked by network unavailability, so refresh `origin/main` before the next phase gate.

## Parallel implementation and pull requests

Keep all implementation off `main` during this rollout. Create one temporary integration branch per repository from the current `main`: `codex/onprem-rollout-be`, `codex/onprem-rollout-fe`, and `codex/onprem-rollout-workflow`. Use short-lived feature branches in isolated checkouts for each reviewable slice, and target their PRs at that repository's integration branch. Stack dependent PRs only within the same repository; once a lower slice lands in its integration branch, retarget the next PR there. Record cross-repository dependencies here and do not integrate a dependent slice until its contract is available in the corresponding repository's integration branch. Keep integration branches current with `main` at phase gates and before final review. Merge the integration branches to `main` only after Phase 5 acceptance, including the deferred mixed-deployment E2E run, succeeds; then retire them. Keep the older divergent feature branches intact as recovery copies and do not merge them wholesale. Group commits around coherent behavior; each PR is a review and rollback unit. Keep incomplete capabilities gated.

The existing CI supports these temporary branches: backend and frontend push/PR gates have no branch filters, and workflow validation runs on matching pull-request paths without a base-branch restriction. The workflow repository's `publish-v1-tag.yml` remains main-only. These implementation branches are separate from customer deployment source branches (`dev`, `uat`, and `main`).

**Baseline and local progress (2026-10-05):** the locally cached `origin/main` heads are backend `b56aae1`, frontend `5fdf53e`, and `alphaci-workflow` `2bbc4f5` (last fetched 2026-10-04). A live `ls-remote` check could not reach GitHub, so these may have moved. The older `codex/configurable-deployment-targets` branches remain preserved: backend is 22 commits ahead / 59 behind, frontend 2 ahead / 106 behind, and workflow 4 ahead / 4 behind. The rollout branches below use the cached bases; refresh and reconcile them with current `main` before the next phase gate. Do not merge the stale branches wholesale.

| Repository | Local short-lived stack | Base and current evidence |
|---|---|---|
| Backend | E1 `codex/onprem-stack-20261004-be-e1` (`6eceaab`); R1 `codex/onprem-stack-20261004-be-r1` (`1fe1054`) | Both start from `b56aae1`. E1 typecheck, build, documentation, schema-ownership, capability, application-boundary, targeted ESLint, and diff checks passed. Its generated route baseline lists main's 207 routes plus the three E1 controller routes; the runtime route-inventory command exited 1 without diagnostics, so actual route enumeration remains unverified. No DB/API/E2E acceptance was run. R1 typecheck, build, changed-file lint, and diff checks passed; its unit tests were not run. |
| Frontend | F1 `codex/onprem-stack-20261004-fe-f1-main` (`9075a37`) -> F2 `codex/onprem-stack-20261004-fe-f2-after-f1` (`90fb9cb`) | F1 starts from `5fdf53e`; F2 is stacked on F1. Typecheck, production build, documentation, architecture-boundary, changed-file lint, and diff checks passed on both. Builds warned that `NEXT_PUBLIC_API_BASE_URL` was unset and used the local `http://localhost:4000` fallback; no deployed API connection was verified. The earlier reversed F1/F2 branches remain intact as recovery copies. |
| `alphaci-workflow` | W1 `codex/onprem-stack-20261004-workflow-w1` (`f434c01`) -> W2 `codex/onprem-stack-20261004-workflow-w2` (through `827c860`) | Based on workflow `2bbc4f5`. W2 carries KMS signing, lab-key fallback, SARIF handling, the customer-host GHCR authentication note, and CRLF-tolerant contract validators. GCP contract, matcher, workflow-doc/comment, and diff checks pass. TRX validation is blocked locally by missing Windows Python; manifest validation by missing Windows `jq`; WSL has no Node; local `actionlint` is unavailable. CI validation remains required. |

| Stack | PR branches in merge order | Repository | Dependency |
|---|---|---|---|
| Environment core | E1 `codex/onprem-stack-20261004-be-e1` -> E2 `codex/onprem-stack-20261004-be-e2` -> E3 `codex/onprem-stack-20261004-be-e3` | Backend | E1 starts from latest `main`; target `codex/onprem-rollout-be` |
| On-prem control | C1 `codex/onprem-stack-20261004-be-c1` -> C2 `codex/onprem-stack-20261004-be-c2` -> C3 `codex/onprem-stack-20261004-be-c3` | Backend | C1 from E1; C2 depends on E3 and C1; C3 from C2; target `codex/onprem-rollout-be` |
| Host package | H1 `codex/onprem-stack-20261004-be-h1` -> H2 `codex/onprem-stack-20261004-be-h2` | Backend | H1 from C1; H2 from H1; target `codex/onprem-rollout-be` |
| Central workflows | W1 `codex/onprem-stack-20261004-workflow-w1` -> W2 `codex/onprem-stack-20261004-workflow-w2` | `alphaci-workflow` | W1 starts from latest `main`; W2 consumes the C1 API contract; target `codex/onprem-rollout-workflow` |
| React image | R1 `codex/onprem-stack-20261004-be-r1` | Backend | Independent from latest backend `main`; target `codex/onprem-rollout-be` |
| Product UI | F1 `codex/onprem-stack-20261004-fe-f1-main` -> F2 `codex/onprem-stack-20261004-fe-f2-after-f1` | Frontend | F1 waits for E1; F2 waits for E2/E3; target `codex/onprem-rollout-fe` |

The parallel waves remain **E1 + W1 + R1**, then **E2 + C1 + F1**, then **E3 + W2 + H1**, then **C2 + H2 + F2**. Local branches can be prepared in parallel, but each PR targets its repository's rollout branch and waits for its cross-repository contract. C3 stays draft until the central `@v1` ref contains W2, the host package and UI have landed, and the mixed deployment acceptance run passes. E2E remains deferred during implementation; no current-main on-prem readiness claim is made. Keep all three rollout branches off `main` until that acceptance run passes, then prepare one final integration-to-`main` PR per repository for coordinated review.

### Phase 0: integrate the baseline and lock the contracts

- [x] Record the initial local branch bases and update ADR-0012 and the host guide.
  Evidence: plan commit `b8923df`, backend merge `acb0f04`, and matching local
  and remote `main` tips in frontend and central workflow on 2026-09-25.
- [x] Integrate this deployment-target plan, ADR-0012, and host guide into
  remote `main` through reviewed PR #100 before implementation PRs. Evidence:
  merged as `4575e1c`; documentation, boundary, and full CI checks passed.
- [x] Freeze the E1 environment API, E2 target identity, C1 release manifest,
  and W1 reusable-workflow inputs below. Copy these contracts into the first
  implementation PR descriptions; target those PRs at the per-repository
  rollout branches. Evidence: Phase 0 read-only backend, workflow, and baseline
  reviews on 2026-09-25.

These contracts were frozen before implementation. E1 and W1 now have local feature slices, and FE setup/operations slices are also staged locally. The contracts remain the target for review; a local branch is not a landed or production-ready capability. Keep the current branch-based API and generated workflow behavior for legacy projects until their environment mapping is explicit.

| Slice | Public contract | Required invariant |
|---|---|---|

| Slice | Public contract | Required invariant |
|---|---|---|
| E1 | `GET /projects/:projectId/environments` returns ordered `{id, slug, displayName, position, sourceBranch, role, autoDeploy}` records. `POST` adds an environment; `PATCH /:environmentId` changes its display name. Project creation accepts an ordered `environments` array. `role` is `production` or `non_production`; test/UAT are display names, not fixed roles. | UUID `id` and slug are permanent; slug and position are unique per project; position is contiguous; exactly one environment is production; `autoDeploy` is read-only and true only at position zero. Source branches may repeat. Live source-branch, order, role, slug, and delete changes are rejected until a migration flow exists. Session auth and project authorization match deployment-target routes. |
| E2 | Target create/list/update responses include `environmentId`; the target key is `(projectId, environmentId, slot)`, with one provider and stable target ID. A branch remains an environment's source setting and is never used to choose a target. | Reject duplicate, absent, missing, or failed targets without fallback. Keep env-var metadata and custom domains attached to their existing target IDs during migration; provider-specific environment labels are configuration on that target. Provision and protect the named GitHub Environment before a generated workflow references it. |
| C1 | A new-mode `POST /ci/releases` registers a project-scoped immutable release with a UUID, full source commit SHA, source environment ID, per-slot artifact digests, and workflow provenance. `GET /ci/releases/:id` reads it. A session-authenticated `POST /projects/:projectId/environments/:environmentId/promotions` with `{releaseId}` creates a deployment of that release to the next ordered environment. Retain the current CI request/opaque ID response as a legacy compatibility path until callers migrate. | CI tokens may register and inspect their project's package but cannot promote, approve, or change a production pin. Release build/verification state and per-environment deployment/health/rollback state are separate persistent records. Promotion checks the immediately preceding environment's pinned release, target identity, authorization, and immutable artifacts. Only the first environment may deploy automatically. |
| C1 manifest | Canonical signed payload: `schemaVersion`, `releaseId`, `projectId`, `sourceEnvironmentId`, `sourceBranch`, full `commitSha`, `createdAt`, `artifacts[{slot, image, digest}]`, optional `migrations[{id, checksum, mode}]`, and `workflowRun{provider, repo, runId, url}`. Envelope: manifest hash plus `signature{algorithm, keyId, value}`. A host assignment separately names destination environment and target IDs. | Container artifact references use `image@sha256:<64 hex>`; floating tags are refused. The host verifies the signature with its pinned public key before pulling any artifact. Neither manifest nor assignment contains host secrets. Vercel records its own deployment ID from the pinned commit rather than claiming the same image digest. |
| W1 | Preserve existing reusable-workflow inputs, defaults, and outputs. Add optional string `environment-id`, `environment-name`, and `target-id` to managed deploy/release workflows. Keep existing `commit-sha`/`checkout-ref`, `artifact`, `image-digest`, and Vercel deployment outputs; expose a canonical digest image reference from `docker-build.yml`. New-mode callers provide the IDs, a full pinned SHA, and digest for container targets explicitly. | Legacy callers continue their current path when new IDs are absent. New-mode callers never resolve an environment or target from branch text and never fall back to DEV/UAT/MAIN credentials. The caller validates the provisioned, protected GitHub Environment and exact target before invoking deployment. Branch pushes to later environments can run quality gates but cannot call deployment; explicit promotion supplies the release ID. Render and Compose reuse the same digest; Vercel checks out the pinned SHA and records its distinct deployment ID. |

E1 backfill uses effective project branches and target settings. If those settings cannot unambiguously identify one production environment, leave that project on the legacy compatibility path and require an operator mapping; never guess from the name `main` or change its current deployment behavior. E2 then attaches legacy target rows to the resolved environment IDs without replacing target IDs. E3 owns generated caller changes: W1 alone does not remove the current fixed `dev`/`uat`/`main` enumeration. W2 owns manifest signing and registration; W1 does not add host credentials to a deploy job.

For private GHCR packages, the customer host uses its own machine-account token limited to `read:packages`. Store it only on the host for digest pulls; do not pass it into Actions or place it in the AlphaCI release record or signed manifest. Public packages need no host pull token. The workflow contract is documented in `alphaci-workflow/docs/workflows/docker-build.md`; host installation and rotation are in the setup guide.

### Phase 1: environment identity and reusable foundations (E1, W1, R1)

Local branches for E1, W1, R1, F1, F2, and W2 are prepared as listed above. The E1 slice has fresh compile/static-gate evidence; the FE stacks have fresh compile/static-gate evidence with the build-time API URL warning recorded. Workflow validation has partial local coverage (see the table); the actionlint CI gate and missing local prerequisites remain. R1 compile/static checks pass; its unit tests were not run. Merge these feature PRs into the per-repository rollout branches after review; do not merge them to `main` during these phases.

- [ ] **E1**, backend PR to `codex/onprem-rollout-be`: add project-owned ordered environment
  records and API with stable ID, immutable slug, display name, source branch,
  role, and exactly one production environment. Accept additions and display
  name changes; reject destructive edits until a migration flow exists. Backfill
  existing projects without changing their branches, targets, or hosted costs.
  Evidence: additive migration on a disposable database and API behavior for
  legacy and custom projects, including two environments on one branch.
- [ ] **W1**, central workflow PR to `codex/onprem-rollout-workflow`: extend existing `docker-build.yml`,
  `release.yml`, `render-deploy.yml`, and `vercel-deploy.yml` only where their
  contracts need pinned commit, environment ID, target ID, or artifact output.
  Remove fixed test/UAT/main secret or branch assumptions from managed deploy
  selection. Require a validated GitHub Environment identifier from the
  caller. Update contract docs, catalog, and validation lists; avoid a new
  reusable workflow when an existing one fits. Evidence: reusable callers
  accept nonstandard names and immutable release references.
- [ ] **R1**, backend PR to `codex/onprem-rollout-be`: add a static-serving Dockerfile to the
  generated React scaffold and reproducible GHCR build path. Keep Vercel
  deployment available. Evidence: image digest tied to the scaffold revision.

### Phase 2: targets, release API, and setup UI (E2, C1, F1)

- [ ] **E2**, backend PR based on E1: key deployment targets and environment
  variables by environment ID and slot, rather than branch alone. Make provider
  provisioning and environment URLs use the chosen target; reject duplicates,
  missing targets, and failed targets without fallback. Map existing rows and
  provider-native Render/Vercel settings without changing legacy behavior.
  Provision each GitHub Environment and its available protection rules before
  a generated workflow can reference it. Evidence: same-branch environments
  keep separate secrets and destinations; no unprotected environment is
  created implicitly by the first workflow run.
- [ ] **C1**, backend PR based on E1: define project/host-scoped release API,
  signed-manifest schema, outbound polling, status, and token boundaries using
  environment ID, source commit, and immutable slot artifacts. Keep it inactive
  for projects without on-prem targets. Evidence: authorization and manifest
  behavior at the API boundary.
- [ ] **F1**, frontend PR to `codex/onprem-rollout-fe`: edit the ordered environment set
  during project setup, starting from the editable `dev/uat/main` template.
  Read E1's API, display the actual created branches, and remove frontend-only
  branch-rank constants. Existing projects display their effective legacy
  configuration without automatic changes.

### Phase 3: generic promotion and signed delivery (E3, W2, H1)

- [ ] **E3**, backend PR based on E2: generate triggers and quality/deploy jobs
  from the project environment definition. Only the first project environment
  auto-deploys on a source-branch push. Promotion is an explicit, authorized
  release operation that carries the pinned commit and slot artifacts to the
  next environment, verifies its target and health, and records its outcome. Keep
  optional branch PRs separate from deployment promotion. Evidence: generated
  workflows for nonstandard names, shared branches, managed-only projects, and
  the mixed-provider example.
- [ ] **W2**, central workflow PR based on W1: add the missing reusable
  on-prem manifest-signing and registration workflow, or extend `release.yml`
  if its contract can remain host-neutral. Sign with the AlphaCI Cloud KMS
  key; register through C1's API. The manifest includes environment ID,
  release ID, pinned commit, image digests, and migration version when present.
  Update docs and workflow validation. No CI job receives host credentials.
- [ ] **H1**, backend PR based on C1: package a Linux agent under
  `deploy/onprem/agent`. It polls outbound, verifies the pinned public key,
  pulls by digest, applies Compose, checks health, rolls back, and reports
  status. Evidence: repeatable signed-release, tamper, and rollback runs on
  the Ubuntu lab host.

### Phase 4: provider, Windows host, and operations UI (C2, H2, F2)

- [ ] **C2**, backend PR based on E3 after C1 merges: add the Compose provider
  pack and workflow fragment using the E2/E3 environment contract. Keep provider
  discovery gated until Phase 5. Evidence: generated workflow and release
  status mapping against a fixture.
- [ ] **H2**, backend PR based on H1: package Caddy/TLS and an idempotent
  Windows bootstrap for the startup task, WSL port forwarding, subnet-scoped
  firewall, and support bundle. Populate the lab host's trust, TLS, and secret
  files with scoped test credentials. Evidence: install, restart, and rerun on
  the laptop without manual repair.
- [ ] **F2**, frontend PR based on F1: configure a provider per environment
  and slot; show environment-scoped secrets, deployment status, artifact
  identity, and explicit promotion controls from E2/E3. Show on-prem host
  settings only after provider discovery advertises C3's enabled pack. Do not
  collapse every non-production environment into UAT.

### Phase 5: activate and prove the mixed configuration (C3)

- [ ] **C3**, backend PR based on C2: register the on-prem provider and
  generated production workflow after E3, H2, R1, F2, and W2 merge. Confirm
  the validated central `@v1` ref contains the new reusable contract before
  any generated caller uses it. Regenerate the provider map.
- [ ] On disposable React and .NET projects, deploy the example test/UAT
  environments to Vercel/Render and production to Ubuntu. Also cover custom
  names and two environments sharing one branch. Verify one auto-deploy per
  push, explicit promotion, pinned source identity, provider isolation,
  install, upgrade, rejected signature, failed-health rollback, and restart
  recovery. Produce a verifiable report and artifacts tied to the source commit, regenerable with one command. Defer this long E2E
  run while building earlier phases, but do not merge C3 or claim client
  readiness until it passes on the laptop and Windows Server 2022 VM with
  nested virtualization.
- [ ] Move the [host setup guide](2026-09-25-onprem-client-setup-guide.md) to
  a current-state runbook after those checks pass; mark ADR-0012 accepted
  only for the delivered scope.

## Done when

One project can name and order its own environments, map two of them to one
source branch, choose a provider for each slot, and promote a pinned release
without an unrequested deploy or provider switch. The example has managed
test/UAT and on-prem production targets. The host passes install, upgrade,
rollback, and restart checks; no CI job or AlphaCI service holds customer host
secrets.
Delete this plan when the last task lands; Git retains it.
