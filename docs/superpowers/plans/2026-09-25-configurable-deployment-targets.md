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
New projects see the editable example above. Before generated workflows name a
GitHub Environment, provision and configure it explicitly; GitHub can otherwise
create an unprotected environment on first workflow use.

This first delivery covers **customer applications**. AlphaCI platform hosting
stays managed. `onprem-k8s` and self-managed AlphaCI platform hosting remain
proposed in ADR-0012 for later work. The separate
[database isolation plan](2026-09-18-multi-deployment-database-isolation.md)
governs AlphaCI's own database deployment modes; this plan does not move that
database to the customer host.

## Current state

- [x] Ubuntu WSL2 test host has its own Docker Engine, Compose, Buildx, Cosign,
  and `/opt/alphaci` directories. Evidence: `docker info` reported Ubuntu
  26.04.1, Docker was active, and `hello-world` ran on 2026-09-25.
- [ ] The host's trust, TLS, and secret files await the release key and scoped
  credentials. The directories are empty; `secrets/` is root-owned, mode 700.
- [ ] Runtime and generated workflows still assume hosted `uat` and `main`;
  `dev` is a working branch without hosted infrastructure. Render can fan out
  to a `main` service. Provider packs for on-prem are not registered.

## Worktrees and pull requests

One Luna agent owns one PR in one Codex-managed worktree. Run up to three
implementation agents concurrently while the root agent reviews contracts and
diffs. A dependent PR initially targets the preceding branch in its own
repository; retarget it to `main` after the lower PR merges. Independent PRs
target `main`. Link cross-repository dependencies in PR descriptions; Git
cannot stack branches across repositories. Keep incomplete capabilities gated.

**Baseline gate:** implementation has not started. On 2026-09-25 the backend checkout was
eight commits ahead and two behind `origin/main`, with untracked `artifacts/`.
Two clean backend worktrees already exist at `cdb78ae` for the old B1/R1 plan;
inspect their ownership and base before reusing them. The central workflow
checkout was clean but four commits behind `origin/main`. The frontend checkout
has its own in-progress branch and untracked files; start its future worktrees
from a fresh remote base. Preserve all existing checkouts. Reconcile remote
bases and land the planning commits before implementation PR branches start.

| Stack | PR branches in merge order | Repository | Dependency |
|---|---|---|---|
| Environment core | E1 `codex/project-environments` -> E2 `codex/environment-targets` -> E3 `codex/environment-pipelines` | Backend | Start from reconciled `main` |
| On-prem control | C1 `codex/onprem-release-contract` -> C2 `codex/onprem-compose-provider` -> C3 `codex/mixed-deployment-activation` | Backend | C1 from E1; C2 from E3 after C1 merges; C3 from C2 |
| Host package | H1 `codex/onprem-host-agent` -> H2 `codex/onprem-windows-host` | Backend | H1 from C1; H2 from H1 |
| Central workflows | W1 `codex/configurable-managed-workflows` -> W2 `codex/signed-onprem-release` | `alphaci-workflow` | W1 from its updated `main`; W2 consumes C1 API |
| React image | R1 `codex/onprem-react-image` | Backend | Independent updated `main` |
| Product UI | F1 `codex/project-environment-setup` -> F2 `codex/environment-operations` | Frontend | F1 consumes E1 API; F2 consumes E2/E3 APIs |

The useful parallel waves are **E1 + W1 + R1**, then **E2 + C1 + F1**, then
**E3 + W2 + H1**, then **C2 + H2 + F2**. Cross-stack work may use a contract
from an open PR, but its merge waits for that dependency to land. C3 stays
draft until the central `@v1` tag includes W2, the host package and UI are
merged, and the mixed deployment acceptance run passes.

### Phase 0: reconcile bases and lock the contracts

- [ ] Reconcile the three repository bases above without discarding local work.
  Freeze the E1 environment API, E2 target identity, C1 release manifest, and
  W1 reusable-workflow inputs in the first PR descriptions. Update ADR-0012
  and the host guide with the environment identity and promotion rules before
  implementation. Open stacked PRs as drafts when their diffs are reviewable.

### Phase 1: environment identity and reusable foundations (E1, W1, R1)

- [ ] **E1**, backend PR to `main`: add project-owned ordered environment
  records and API with stable ID, immutable slug, display name, source branch,
  role, and exactly one production environment. Accept additions and display
  name changes; reject destructive edits until a migration flow exists. Backfill
  existing projects without changing their branches, targets, or hosted costs.
  Evidence: additive migration on a disposable database and API behavior for
  legacy and custom projects, including two environments on one branch.
- [ ] **W1**, central workflow PR to `main`: extend existing `docker-build.yml`,
  `release.yml`, `render-deploy.yml`, and `vercel-deploy.yml` only where their
  contracts need pinned commit, environment ID, target ID, or artifact output.
  Remove fixed test/UAT/main secret or branch assumptions from managed deploy
  selection. Require a validated GitHub Environment identifier from the
  caller. Update contract docs, catalog, and validation lists; avoid a new
  reusable workflow when an existing one fits. Evidence: reusable callers
  accept nonstandard names and immutable release references.
- [ ] **R1**, backend PR to `main`: add a static-serving Dockerfile to the
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
- [ ] **F1**, frontend PR to its own `main`: edit the ordered environment set
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
