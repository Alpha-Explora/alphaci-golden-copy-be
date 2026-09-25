# Configurable deployment targets: managed test and UAT, on-prem main

**Goal:** Let each customer project deploy its React frontend and .NET backend
to Vercel and Render for test and UAT, then to a customer-hosted Compose target
for main, without hand-editing generated workflows. Decision:
[ADR-0012](../../architecture/decisions/adr-0012-configurable-deployment-targets.md).
The [host setup guide](2026-09-25-onprem-client-setup-guide.md) holds the
installation and enterprise-client checklist.

## Deployment target contract

| Branch | Purpose | Frontend slot | Backend slot |
|---|---|---|---|
| `dev` | Test | Vercel preview | Render test service |
| `uat` | UAT | Vercel preview | Render UAT service |
| `main` | Production | `onprem-compose` | `onprem-compose` |

The provider is selected for each `(project, slot, branch)` target. At most
one configured provider owns that tuple, regardless of health status; a
missing or failed target cannot fall back to another provider. Promotion stays
`dev -> uat -> main`. Switching `main` later changes
only its deploy destination, while `dev` and `uat` keep their providers.
Quality gates stay shared. The package and deploy jobs follow the chosen
provider: Vercel builds the frontend previews, Render uses its image path, and
the on-prem target publishes immutable images and a signed release manifest to
GHCR. The on-prem host pulls by digest; CI holds no host credentials.

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

Each named PR below gets its own Codex-managed worktree and `codex/` branch.
Its commits form one reviewable feature slice. In one repository, a dependent
PR targets the branch named as its base; merge the bottom PR first, then
retarget the next PR to `main`. Independent PRs target `main` immediately.
Cross-repository dependencies are linked in PR descriptions because Git cannot
stack branches across repositories. Do not expose `onprem-compose` in project
setup until the workflow and host paths are ready. B4 stays draft until the
end-to-end host checks pass; earlier PRs can merge with the provider gated.

**Baseline gate:** before creating implementation worktrees, reconcile the
backend's local `main` with `origin/main` (six local commits ahead when this
plan was split). Use a fresh frontend worktree from updated `origin/main`;
the current frontend checkout is on `codex/golden-copy-trunk` with untracked
files, and its local `main` is stale. The `alphaci-workflow` checkout is clean
on `main`. Preserve those existing checkouts and files.

| Stack | PR order | Repository | Base for first PR |
|---|---|---|---|
| Target and control | B1 -> B2 -> B3 -> B4 | Backend | Updated `main` |
| Host runtime | H1 -> H2 | Backend | B2; H1 and B3 can run in parallel |
| Release workflows | W1 -> W2 | `alphaci-workflow` | Updated `main` |
| React image | R1 | Backend | Updated `main`; independent of B1 |
| Target UI | F1 | Frontend | Updated `origin/main`; depends on B1's API contract |

Merge R1, W1, and B1 as their checks pass. Merge B2 after B1; B3 and H1
after B2; W2 after W1 and B2's contract; H2 after H1; F1 after B1's API is
available. Merge B4 last, after B3, H2, R1, W2, and the host acceptance
checks. Retarget each stacked PR to `main` as its base merges.

### Phase 0: freeze the baseline and contracts

- [ ] Reconcile each repository's branch state above. Record the exact target
  API fields and release-manifest schema in B1/B2 before W2, B3, or F1 code
  depends on them. Open draft stacked PRs as soon as each diff is reviewable;
  merge only when its own checks and dependencies pass.

### Phase 1: provider selection (B1)

- [ ] **B1 `codex/onprem-target-routing`**, backend PR to `main`: key the
  configured provider by project, slot, and branch; reject duplicates and
  missing or failed targets without fallback. Allow an opt-in hosted `dev`
  target without creating paid `dev` services for existing projects. Update
  Runtime provisioning, environment display, Vercel/Render job selection, and
  generated workflow routing together. The example emits managed jobs only
  for `dev` and `uat`; it never creates a Render or Vercel `main` deployment.
  Evidence: generated workflow files and target API behavior for both the
  mixed configuration and unchanged managed-only projects.

### Phase 2: parallel foundations (R1, W1, B2, F1)

- [ ] **R1 `codex/onprem-react-image`**, backend PR to `main`: add a
  static-serving Dockerfile to the generated React scaffold and a reproducible
  image build. Keep the existing Vercel build path. Evidence: built image and
  digest tied to the scaffold revision.
- [ ] **W1 `codex/onprem-image-workflow`**, workflow PR to `main`: add a reusable
  image build that scans, emits an SBOM, pushes React/.NET images to GHCR, and
  outputs immutable digests. Update its workflow contract docs and validation
  allow-list. It must not deploy or need customer host credentials.
- [ ] **B2 `codex/onprem-release-contract`**, backend PR based on B1: define
  the signed-manifest schema and project/host-scoped release API, including
  outbound polling, status, and token boundaries. Keep it inactive for
  projects without an on-prem target. Evidence: authorization and manifest
  behavior at the API boundary.
- [ ] **F1 `codex/onprem-target-ui`**, frontend PR to its own `main`: display
  and edit a provider per slot and branch, show `dev` as test, and render
  on-prem host configuration only when provider discovery advertises B3's
  enabled pack. This PR is independent in Git but requires B1's target API.

### Phase 3: signed release, provider, and agent (W2, B3, H1)

- [ ] **W2 `codex/onprem-signed-release`**, workflow PR based on W1: sign the
  release manifest with the AlphaCI Cloud KMS key and register it through
  B2's API. The manifest names the release ID, environment, image digests,
  and migration version when present. Verify the workflow using a disposable
  release fixture; no CI job receives host credentials.
- [ ] **B3 `codex/onprem-compose-provider`**, backend PR based on B2: add the
  Compose provider pack and workflow fragment, including target validation and
  release-to-host status mapping. Keep provider discovery gated until Phase 5.
  Evidence: generated `main` workflow and provider behavior against a release
  fixture.
- [ ] **H1 `codex/onprem-host-agent`**, backend PR based on B2, parallel to
  B3: package a Linux agent under `deploy/onprem/agent`. It polls outbound,
  verifies the pinned public key, pulls by digest, applies Compose, checks
  health, rolls back, and reports status. Evidence: repeatable signed-release,
  tamper, and rollback runs on the Ubuntu lab host.

### Phase 4: Windows host package (H2)

- [ ] **H2 `codex/onprem-windows-host`**, backend PR based on H1: package
  Caddy/TLS and an idempotent Windows bootstrap for the startup task, WSL
  port forwarding, subnet-scoped firewall, and support bundle. Populate the
  lab host's trust, TLS, and secret files with scoped test credentials.
  Evidence: install, restart, and rerun on the laptop without manual repair.

### Phase 5: activate and prove the mixed configuration (B4)

- [ ] **B4 `codex/onprem-mixed-deployment`**, backend PR based on B3: register
  the on-prem provider and generated `main` workflow only after W2 merges to
  `alphaci-workflow/main` and its validated `@v1` ref contains both new
  reusable workflows, and H2 is merged. Link F1 and R1. Regenerate the
  provider map.
- [ ] On disposable React and .NET projects, deploy `dev`/`uat` to
  Vercel/Render and `main` to the Ubuntu lab host. Verify provider isolation,
  install, upgrade, rejected signature, failed-health rollback, and restart
  recovery. Record a repeatable release report tied to the commit. Defer the
  long E2E run while building earlier phases, but do not claim the on-prem
  path ready for a client or merge B4 until this gate passes on the laptop and
  then on a Windows Server 2022 VM with nested virtualization.
- [ ] Move the [host setup guide](2026-09-25-onprem-client-setup-guide.md) to
  a current-state runbook after those checks pass; mark ADR-0012 accepted
  only for the delivered scope.

## Done when

The same customer project has managed `dev` and `uat` targets and an on-prem
`main` target for its React and .NET slots; promotion does not change providers
behind the operator's back. The host passes install, upgrade, rollback, and
restart checks, and no CI job or AlphaCI service holds customer host secrets.
Delete this plan when the last task lands; Git retains it.
