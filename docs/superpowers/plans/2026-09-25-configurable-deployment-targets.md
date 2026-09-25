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

## Tasks

### 1. Choose a provider for every hosted branch

- [ ] Make `dev` a hosted test target and keep branch provisioning, promotion,
  environment display, and workflow triggers in agreement.
- [ ] Let project setup and the target API/UI assign a provider by slot and
  branch. Prevent duplicate configured targets and fail visibly if a target is
  missing; preserve existing Vercel/Render behavior for projects that retain it.
- [ ] Scope Vercel jobs to `dev` and `uat`, and Render services and jobs to
  `dev` and `uat`, for the example configuration. Do not create or deploy a
  managed `main` service when `main` selects `onprem-compose`.

### 2. Publish a release for on-prem main

- [ ] Add a static-serving Dockerfile to the generated React scaffold; reuse
  the .NET Linux image path. Build and scan the `main` images, produce an SBOM,
  publish to GHCR, and record immutable digests.
- [ ] Add the on-prem artifact and release workflows in `alphaci-workflow`.
  Sign a manifest containing the frontend and backend digests, release ID,
  environment, and migration version when present with the AlphaCI Cloud KMS
  key; register that release with the AlphaCI API. Keep host credentials out
  of CI.

### 3. Run the Compose target

- [ ] Add the `onprem-compose` Runtime provider pack and workflow fragment.
  The host agent polls outbound, verifies the signed manifest with a pinned
  public key, pulls images by digest, applies Compose, checks health, rolls
  back on failure, and reports status.
- [ ] Add Caddy with the client's TLS files and an idempotent Windows host
  bootstrap for the startup task, WSL port forwarding, and subnet-scoped
  firewall rule. Populate the test host's trust, TLS, and secret files only
  when real test credentials exist.

### 4. Prove the mixed deployment configuration

- [ ] On disposable React and .NET projects, deploy `dev` and `uat` to
  Vercel/Render and `main` to the Ubuntu test host. Verify each branch reaches
  only its configured provider, and capture repeatable release evidence.
- [ ] Verify main install, upgrade, failed-health rollback, signature rejection,
  and restart recovery on the laptop, then repeat on a Windows Server 2022 VM
  with nested virtualization. Keep the E2E work documented until this harness
  is practical to run.
- [ ] Turn the [host setup guide](2026-09-25-onprem-client-setup-guide.md) into
  a current-state runbook after these checks pass; regenerate the provider map
  and mark ADR-0012 accepted only for the delivered scope.

## Done when

The same customer project has managed `dev` and `uat` targets and an on-prem
`main` target for its React and .NET slots; promotion does not change providers
behind the operator's back. The host passes install, upgrade, rollback, and
restart checks, and no CI job or AlphaCI service holds customer host secrets.
Delete this plan when the last task lands; Git retains it.
