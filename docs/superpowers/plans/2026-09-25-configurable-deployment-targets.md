# Configurable customer environments and deployment targets

**Goal:** Let each customer project define its own ordered environments and
choose a deployment provider for each frontend/backend target. The first
example uses Vercel/Render for test and UAT, then a customer-hosted Compose
target for production, without hand-editing generated workflows. Decision:
[ADR-0012](../../architecture/decisions/adr-0012-configurable-deployment-targets.md).
The [host setup guide](2026-09-25-onprem-client-setup-guide.md) holds the
installation and enterprise-client checklist.

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
Legacy project creation remains unchanged. Until E2/E3 make provisioning
environment-aware, project creation rejects a custom `environments` array
before any external writes; the environment APIs can still maintain metadata
for projects created through the legacy path. Before generated workflows name
a GitHub Environment, provision and configure it explicitly; GitHub can
otherwise create an unprotected environment on first workflow use.

This first delivery covers **customer applications**. AlphaCI platform hosting
stays managed. `onprem-k8s` and self-managed AlphaCI platform hosting remain
proposed in ADR-0012 for later work. AlphaCI platform database deployment is
outside this plan; customer application targets do not move AlphaCI's database
to the customer host.

## Current state

- [x] Ubuntu WSL2 test host has its own Docker Engine, Compose, Buildx, Cosign,
  and `/opt/alphaci` directories. Evidence: `docker info` reported Ubuntu
  26.04.1, Docker was active, and `hello-world` ran on 2026-09-25.
- [ ] The host's trust, TLS, and secret files await the release key and scoped
  credentials. The directories are empty; `secrets/` is root-owned, mode 700.
- [ ] Runtime and generated workflows still assume hosted `uat` and `main`;
  `dev` is a working branch without hosted infrastructure. Render can fan out
  to a `main` service. Provider packs for on-prem are not registered.

## Implementation order and pull requests

Implement inline in each repository's single main checkout, one slice at a
time, with no extra checkouts or parallel agents. For each slice: fetch,
create the slice branch from `origin/codex/configurable-deployment-targets`,
implement, verify, push, open the PR, and merge it before starting the next
slice. A slice
therefore always starts with its dependencies merged, so no PR stacks on
another. Before switching branches, commit or stash the checkout's current
work; the backend checkout's `codex/golden-copy-trunk` keeps its unrelated
local commits.

This plan uses a dedicated
`codex/configurable-deployment-targets` integration branch in the backend,
frontend, and `alphaci-workflow` repositories. Each branch was created from its
current `main` on 2026-09-25; these branches are not repository defaults and do
not change the repositories' default-branch setting. Only PRs for this plan
target the relevant repository's `codex/configurable-deployment-targets`;
unrelated work continues to target `main`. When the planned work is ready for
production, open a release PR from each plan integration branch to that
repository's `main`. Link cross-repository dependencies in PR
descriptions. Keep incomplete capabilities gated.

**Baseline:** the focused deployment plan, ADR-0012, and host guide landed on
`main` as PR #100 at `4575e1c`; PR #101 closed Phase 0 at `1db35f6`. The
integration branches were created from these `main` commits: backend
`1db35f6`, frontend `572a8fe`, and central workflows `5031605`. The repositories
keep `main` as their GitHub default branch; later `main` updates remain separate
until an explicit integration or release PR. The backend's 12 prior local-only
commits are preserved on
`codex/archive-main-before-phase1`; its untracked `artifacts/` and the
frontend's untracked pnpm files remain untouched. Existing backend PR #75 and
frontend PR #41 still target the older `codex/golden-copy-trunk` branch and are
unrelated to this plan's new `codex/configurable-deployment-targets` branches.

GitHub reports all three plan integration branches as unprotected. This plan's
PR targeting is therefore a workflow convention, not a server-enforced policy.
Keep changes to both `codex/configurable-deployment-targets` and production
`main` in reviewed PRs.

E1 (backend #104), R1 (backend #105), and W1 (`alphaci-workflow` #30) are
merged. The remaining slices run in this order:

| Order | Slice | Branch | Repository | Needs merged first |
|---|---|---|---|---|
| 1 | X0 | `codex/e2e-suite` | Backend | E1 |
| 2 | E2 | `codex/environment-targets` | Backend | E1, X0 |
| 3 | C1 | `codex/onprem-release-contract` | Backend | E1, X0 |
| 4 | E3 | `codex/environment-pipelines` | Backend | E2 |
| 5 | W2 | `codex/signed-onprem-release` | `alphaci-workflow` | W1, C1 |
| 6 | H1 | `codex/onprem-host-agent` | Backend | C1 |
| 7 | C2 | `codex/onprem-compose-provider` | Backend | C1, E3 |
| 8 | F1 | `codex/project-environment-setup` | Frontend | E3 |
| 9 | H2 | `codex/onprem-windows-host` | Backend | H1 |
| 10 | F2 | `codex/environment-operations` | Frontend | F1, E2, E3 |
| 11 | C3 | `codex/mixed-deployment-activation` | Backend | C2, H2, R1, F2, W2 |

C3 stays draft until the central `@v1` tag includes W2 and the mixed
deployment acceptance run passes.

#### Implementation rules

- Merge a PR into the integration branch once CI is green and review passes,
  then start the next slice from the updated integration branch.
- Start from the slice's contract row and done criteria. Read the files it
  changes and their callers.
- Before coding, list the slice's failure modes in the PR description. Each
  failure mode gets one assertion in the X0 E2E suite, or a real-database
  integration test when HTTP cannot reach it cheaply. Nothing else gets a test.
- Fake only external systems (GitHub, Render, Vercel, GHCR, KMS) at their
  existing ports, and record what they received. Do not mock backend
  repositories or services.
- Do not write DTO or validator unit tests, mock-echo service tests, snapshots
  of generated YAML or SQL text, or tests of private helpers. For generated
  workflows, parse the YAML, assert which jobs deploy on which trigger, and run
  actionlint.
- Iterate with typecheck and the targeted test file. Run lint, the full test
  suite, and the touched `check:*` gates once before pushing; CI repeats them.
- Each slice PR ticks its own task here and links its evidence in one line.
  Regenerate `*.generated.md` files only when a PR changes their inputs.
- Squash each PR to one Conventional Commit. Extend existing validators and
  scripts; add no new scripts, gates, or refactors outside the slice.
- Review each PR once for correctness, security, and contract drift before
  merging. Only P0 and P1 findings block; list the rest as PR follow-ups.
- Checks that need hosted providers, the WSL host, or the Windows Server VM
  wait for the Phase 5 lab run. Each PR adds its scenario to that checklist.

### Phase 0: integrate the baseline and lock the contracts

- [x] Record the initial local branch bases and update ADR-0012 and the host guide.
  Evidence: plan commit `b8923df`, backend merge `acb0f04`, and matching local
  and remote `main` tips in frontend and central workflow on 2026-09-25.
- [x] Integrate this deployment-target plan, ADR-0012, and host guide into
  remote `main` through reviewed PR #100 before implementation PRs. Evidence:
  merged as `4575e1c`; documentation, boundary, and full CI checks passed.
- [x] Freeze the E1 environment API, E2 target identity, C1 release manifest,
  and W1 reusable-workflow inputs below. Copy these contracts into the first
  implementation PR descriptions; open those PRs as drafts when their diffs
  are reviewable. Evidence: Phase 0 read-only backend, workflow, and baseline
  reviews on 2026-09-25.

#### Frozen implementation contracts

These are design contracts for E1, E2, C1, and W1, not claims that the APIs or
workflows exist. Keep the current branch-based API and generated workflow
behavior for legacy projects until their environment mapping is explicit.

| Slice | Public contract | Required invariant |
|---|---|---|
| E1 | `GET /projects/:projectId/environments` returns ordered `{id, slug, displayName, position, sourceBranch, role, autoDeploy}` metadata records. `POST` appends one environment and `PATCH /:environmentId` changes its display name; these are metadata-only operations and cannot initialize or reorder a complete environment set. Project creation temporarily rejects a supplied custom `environments` array before any external writes; requests without one retain legacy creation behavior. The environment APIs maintain metadata for existing and legacy-created projects. `role` is `production` or `non_production`; test/UAT are display names, not fixed roles. | UUID `id` and slug are permanent; slug and position are unique per project; position is contiguous; exactly one environment is production; `autoDeploy` is read-only and true only at position zero. Source branches may repeat. Live source-branch, order, role, slug, and delete changes are rejected until a migration flow exists. Session auth and project authorization match deployment-target routes. Keep the create-time array rejection until E2/E3 provide and verify complete environment-aware provisioning and generated deployment behavior. |
| E2 | Target create/list/update responses include `environmentId`; the target key is `(projectId, environmentId, slot)`, with one provider and stable target ID. A branch remains an environment's source setting and is never used to choose a target. | Reject duplicate, absent, missing, or failed targets without fallback. Keep env-var metadata and custom domains attached to their existing target IDs during migration; provider-specific environment labels are configuration on that target. Provision and protect the named GitHub Environment before a generated workflow references it. |
| C1 | A new-mode `POST /ci/releases` registers a project-scoped immutable release with a UUID, full source commit SHA, source environment ID, per-slot artifact digests, and workflow provenance. `GET /ci/releases/:id` reads it. A session-authenticated `POST /projects/:projectId/environments/:environmentId/promotions` with `{releaseId}` creates a deployment of that release to the next ordered environment. Retain the current CI request/opaque ID response as a legacy compatibility path until callers migrate. | CI tokens may register and inspect their project's package but cannot promote, approve, or change a production pin. Release build/verification state and per-environment deployment/health/rollback state are separate persistent records. Promotion checks the immediately preceding environment's pinned release, target identity, authorization, and immutable artifacts. Only the first environment may deploy automatically. |
| C1 manifest | Canonical signed payload: `schemaVersion`, `releaseId`, `projectId`, `sourceEnvironmentId`, `sourceBranch`, full `commitSha`, `createdAt`, `artifacts[{slot, image, digest}]`, optional `migrations[{id, checksum, mode}]`, and `workflowRun{provider, repo, runId, url}`. Envelope: manifest hash plus `signature{algorithm, keyId, value}`. A host assignment separately names destination environment and target IDs. | Container artifact references use `image@sha256:<64 hex>`; floating tags are refused. The host verifies the signature with its pinned public key before pulling any artifact. Neither manifest nor assignment contains host secrets. Vercel records its own deployment ID from the pinned commit rather than claiming the same image digest. |
| W1 | Preserve existing reusable-workflow inputs, defaults, and outputs. Add optional string `environment-id`, `environment-name`, and `target-id` to managed deploy/release workflows. Keep existing `commit-sha`/`checkout-ref`, `artifact`, `image-digest`, and Vercel deployment outputs; expose a canonical digest image reference from `docker-build.yml`. New-mode callers provide the IDs, a full pinned SHA, and digest for container targets explicitly. | Legacy callers continue their current path when new IDs are absent. New-mode callers never resolve an environment or target from branch text and never fall back to DEV/UAT/MAIN credentials. The caller validates the provisioned, protected GitHub Environment and exact target before invoking deployment. Branch pushes to later environments can run quality gates but cannot call deployment; explicit promotion supplies the release ID. Render and Compose reuse the same digest; Vercel checks out the pinned SHA and records its distinct deployment ID. |

E1 backfill uses effective project branches and target settings only when they
identify the environment set, its order, and its single production role without
guessing. Existing target rows have no authoritative order field, and prior
code derived some provider environment labels from branch names. Therefore
multi-branch projects and projects whose only production signal is a
branch-derived `main` or `production` label remain on the legacy compatibility
path until an operator maps them. Never infer production from the name `main`
or change existing deployment behavior.
E2 then attaches legacy target rows to the resolved environment IDs without
replacing target IDs. E3 owns generated caller changes: W1 alone does not
remove the current fixed `dev`/`uat`/`main` enumeration. W2 owns manifest
signing and registration; W1 does not add host credentials to a deploy job.

### Phase 1: environment identity and reusable foundations (E1, W1, R1)

- [x] **E1**, backend PR to this plan's `codex/configurable-deployment-targets`:
  add project-owned ordered environment records and API with stable ID,
  immutable slug, display name,
  source branch, role, and exactly one production environment. Accept additions
  and display-name changes through the environment API; reject destructive
  edits until a migration flow exists. Preserve legacy project creation and
  reject a supplied custom `environments` array before external writes until
  environment-aware provisioning is delivered in E2/E3. Backfill only
  projects whose stored targets identify an environment set, order, and
  production role without branch-derived guesses. Keep other projects on their
  existing deployment path and require an operator mapping; do not change
  branches, targets, or hosted costs. Evidence: additive migration on a
  disposable database; list/add/rename metadata behavior for legacy-created
  projects, including two environments on one branch; and pre-write rejection
  of custom create-time arrays while legacy creation remains unchanged.
  Merged as #104 `97b980f`; its runtime evidence comes from X0.
  Evidence: X0 E2E report (API, backfill, rerun, rollback, pre-write rejection).
- [ ] **W1**, central workflow PR to this plan's `codex/configurable-deployment-targets`:
  extend existing `docker-build.yml`, `release.yml`, `render-deploy.yml`, and
  `vercel-deploy.yml` only as required for pinned commits, environment IDs,
  target IDs, or artifact outputs.
  Remove fixed test/UAT/main secret or branch assumptions from managed deploy
  selection. Require a validated GitHub Environment identifier from the
  caller. Update contract docs, catalog, and validation lists; avoid a new
  reusable workflow when an existing one fits. Evidence: static workflow
  contract checks cover optional target identity and immutable image references
  while legacy defaults remain intact. Generated caller behavior and promotion
  evidence are verified with E3/W2 acceptance.
  Merged as `alphaci-workflow` #30 `0259d34`.
- [ ] **R1**, backend PR to this plan's `codex/configurable-deployment-targets`:
  add a static-serving Dockerfile to the generated React scaffold and a
  reproducible GHCR build path. Keep Vercel deployment available. Scan the
  exact pushed image digest and fail on HIGH or
  CRITICAL vulnerabilities. Evidence: successful build and scan with the image
  digest tied to the scaffold revision.
  Merged as #105 `2bd98f8`; the build and scan run is pending.

R1 images are candidate artifacts only. They are not eligible for on-prem
release or host deployment until W2 signs a release manifest naming the image
digest and registers that manifest through C1. A successful R1 scan does not
replace W2 signing and registration.

#### Deferred Phase 1 end-to-end acceptance

Defer runtime end-to-end runs while Phase 1 is under implementation review. Do
not mark Phase 1 complete until repeatable evidence is saved for:

- E1: migration, safe backfill and rollback on a disposable PostgreSQL
  database; authenticated list/add/rename of environment metadata for a
  legacy-created project, including two environments sharing one branch;
  custom create-time arrays are rejected before external writes, and legacy
  project creation and existing deployment paths remain unchanged. X0
  produces this evidence.
- W1 with E3 callers: a generated caller passes nonstandard environment and
  target IDs, a full source SHA, and an immutable container digest; Render uses
  the digest, Vercel records its deployment ID, and a legacy caller still works.
- R1: a generated React project installs from its committed lockfile, builds
  and serves the static image, and the GHCR workflow scans the exact published
  digest before reporting it.

The saved artifact must identify the commit and reproducible commands and
include the relevant workflow run, migration/API output, image digest, scanner
result, and container health result. Static checks and code review do not count
as runtime acceptance evidence.

### Phase 2: targets and release API (E2, C1)

- [x] **E2**, backend PR based on E1: key deployment targets and environment
  variables by environment ID and slot, rather than branch alone. Make provider
  provisioning and environment URLs use the chosen target; reject duplicates,
  missing targets, and failed targets without fallback. Map existing rows and
  provider-native Render/Vercel settings without changing legacy behavior.
  Provision each GitHub Environment and its available protection rules before
  a generated workflow can reference it. Evidence: same-branch environments
  keep separate secrets and destinations; no unprotected environment is
  created implicitly by the first workflow run.
  Evidence: E2E `deployment-target-environments` scenarios and backfill run.
- [x] **C1**, backend PR based on E1: define project/host-scoped release API,
  signed-manifest schema, outbound polling, status, and token boundaries using
  environment ID, source commit, and immutable slot artifacts. Keep it inactive
  for projects without on-prem targets. Evidence: authorization and manifest
  behavior at the API boundary.
  Evidence: E2E `release-registry` scenarios; host API off unless enabled.
- [x] **X0**, backend PR to this plan's `codex/configurable-deployment-targets`,
  before E2 and C1: add the shared E2E suite. It starts the Nest app against
  the disposable loopback PostgreSQL fixture, applies migrations, signs in a
  test user, and drives the HTTP API. External providers are recording fakes
  behind their existing ports. `npm run test:e2e` writes
  `artifacts/e2e/<commit>/report.json` with the commit, commands, and
  per-scenario results, and CI runs it. The first scenarios cover E1's
  deferred acceptance. Evidence: the report for the X0 commit.
  Evidence: 19 scenarios pass locally and in the CI `E2E` job (`e2e-report`).

### Phase 3: generic promotion, signed delivery, and setup UI (E3, W2, H1, F1)

- [ ] **E3**, backend PR based on E2: generate triggers and quality/deploy jobs
  from the project environment definition. Enable custom create-time
  environment arrays only after E2/E3 provisioning and generated callers honor
  the definition; retain E1's pre-write rejection until that path is verified.
  Only the first project environment
  auto-deploys on a source-branch push. Promotion is an explicit, authorized
  release operation that carries the pinned commit and slot artifacts to the
  next environment, verifies its target and health, and records its outcome. Keep
  optional branch PRs separate from deployment promotion. Evidence: generated
  workflows for nonstandard names, shared branches, managed-only projects, and
  the mixed-provider example. This phase restores custom create-time environment
  arrays only after complete environment-aware provisioning and generated
  callers are verified; E1's pre-write rejection remains until then.
- [ ] **F1**, frontend PR to this plan's `codex/configurable-deployment-targets`
  after E3 merges: edit the complete ordered environment definition during
  project setup, starting from
  the editable `dev/uat/main` template and using E3's environment-aware
  project-creation contract. Display the actual created branches and remove
  frontend-only branch-rank constants. Existing projects display their
  effective legacy configuration without automatic changes.
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
  recovery. Record a repeatable report tied to the commit. Defer this long E2E
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
