# Configurable deployment targets: on-premises setup

**Goal:** Make deployment a setting. Managed providers (Vercel, Render, GCP)
stay the default; customer-hosted Compose (Windows + WSL2 first) and
Kubernetes become options for both the AlphaCI platform and the projects it
deploys. Decision: [ADR-0012](../../architecture/decisions/adr-0012-configurable-deployment-targets.md).

Detailed research (Windows-first toolchain, WSL2 networking, recovery cases)
lives on branch `codex/golden-copy-trunk` in
`docs/architecture/onprem-toolchain.md`,
`docs/architecture/deployment-workflows-onprem-report.md`, and
`docs/runbooks/runbook-self-managed-database.md`. This plan supersedes the
earlier Kubernetes-only GitOps report.

## How it fits today's pipeline

Generated repos run `00 access -> 05 env guard -> 10 quality -> 20 package ->
30 verify` on `dev -> uat -> main`. The stack fragment decides quality and
build; the provider fragment decides the deploy step. Only the deploy step
changes:

| Stack | Today (default) | Customer-hosted |
|---|---|---|
| React | `npm run build` -> `vercel-deploy.yml` (no image) | new nginx/Caddy image -> GHCR digest -> manifest |
| .NET | `dotnet publish` -> `docker-build.yml` -> `release.yml` (Render) | same image -> GHCR digest -> manifest |

A project picks a provider per deployment target, for example:

```json
{ "slot": "backend", "branch": "main", "provider": "onprem-compose",
  "providerData": { "hostId": "acme-win-01", "registry": "ghcr", "connectivity": "connected" } }
```

## Tools (checked)

| Tool | Where it runs | Status | Note |
|---|---|---|---|
| WSL2 Ubuntu | Windows host | Right | Keep data on the Linux filesystem, never `/mnt/c`. |
| Docker Engine + Compose plugin | Inside WSL2 | Right | Docker Desktop is fine for developers; customer hosts use Docker Engine. |
| Branch protection | GitHub | Already done | Provisioning protects `uat` and `main`; nothing to set up. |
| GHCR | GitHub | Missing from the old list | Images and Helm charts by digest. Nothing deploys without it. |
| Trivy + Cosign | CI | Missing from the old list | Block CRITICAL/HIGH; sign the release manifest. |
| PostgreSQL (`postgres:16`) | Compose or cluster | Right | Replaces the Supabase database only; the API still needs Supabase Auth until an OIDC adapter exists. Self-hosted Supabase needs 4 GB RAM minimum, 8 GB+ recommended. |
| GCE Ubuntu VM | GCP | Right | Lab only; not proof of customer on-prem readiness. |
| K3s | Linux (the GCE VM) | Right tool, wrong host if in WSL2 | K3s supports Linux hosts, not Windows. |
| Helm | CI + cluster | Right | Chart source in `alphaci-workflow`; publish to GHCR as OCI. No secrets in values. |
| Argo CD (includes the UI) | Inside K3s | Right tool, was before the cluster | One tool; the UI ships with it. |
| kubectl | Operator machine or VM | Right | `logs` is a subcommand; K3s bundles `k3s kubectl`. |
| Kubernetes Secrets | Cluster | Right place: the cluster | Create with `kubectl create secret`; later sync from GCP Secret Manager (External Secrets) or use Sealed Secrets. |

## Tasks

### Phase 0: decide (blocks everything)

- [ ] First workload: AlphaCI platform itself, or customer React/.NET projects.
- [ ] First customer-hosted path: Compose on Windows + WSL2 (recommended), or Kubernetes.
- [ ] First Windows target: Windows 11 Pro (feasibility) then Windows Server 2022.
- [ ] Connectivity: connected GHCR (recommended first) or air-gapped bundle.
- [ ] Signing key owner (recommended: AlphaCI key in Cloud KMS; host gets only the public key).

### Phase 1: local foundation (Windows developer machine)

- [ ] `wsl --install -d Ubuntu`, then enable systemd (`[boot] systemd=true` in `/etc/wsl.conf`) and `wsl --shutdown`.
- [ ] Install Docker Engine and the Compose plugin from Docker's apt repository inside Ubuntu.
- [ ] Run the backend against `postgres:16` through Compose (bring the self-managed Compose file from trunk).

### Phase 2: artifacts (needed by every customer-hosted target)

- [ ] Add a React Dockerfile (static build + nginx or Caddy) to the React scaffold.
- [ ] Add `onprem-artifact-build.yml` to `alphaci-workflow`: build, Trivy scan, SBOM, push to GHCR, output digests.
- [ ] Add `onprem-release-publish.yml`: write a Cosign-signed manifest (FE/BE digests, migration version, release id). No host or cluster credentials.
- [ ] Package the Helm chart (`helm package`, `helm push <chart>.tgz oci://ghcr.io/<org>/charts`).

### Phase 3: Compose target (default customer-hosted path)

- [ ] PowerShell bootstrap, idempotent: check Windows version, enable WSL2, install the pinned distro, set resource limits.
- [ ] Windows Task Scheduler runs the bootstrap at boot; it starts WSL and the agent.
- [ ] Agent inside WSL: verify manifest signature, pull by digest, run the one-shot migration, `docker compose up -d`, check health, keep the previous manifest for rollback.
- [ ] Expose only the intended port through Windows Firewall (reverse proxy or managed port forward; no mirrored networking on Windows Server).
- [ ] Register the `onprem-compose` provider pack and workflow fragment in Runtime.

### Phase 4: Kubernetes lab (optional path)

- [ ] `gcloud compute instances create <vm> --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --no-address`; access with `gcloud compute ssh <vm> --tunnel-through-iap`; Cloud NAT for egress.
- [ ] `curl -sfL https://get.k3s.io | sh -`; kubeconfig at `/etc/rancher/k3s/k3s.yaml`.
- [ ] `kubectl create namespace argocd`, then `kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml`.
- [ ] UI: `kubectl port-forward svc/argocd-server -n argocd 8080:443` locally, an Ingress with a hostname on the VM; password from `argocd admin initial-password -n argocd`.
- [ ] `argocd repo add ghcr.io/<org>/charts --type helm --name ghcr --enable-oci` with a read-only token.
- [ ] Secrets: `kubectl create secret generic alphaci-backend -n alphaci --from-env-file=backend.env`; the chart references it by name.
- [ ] A release is a pull request that bumps image digests in a values file; Argo CD applies it.
- [ ] Register the `onprem-k8s` provider pack and workflow fragment in Runtime.

### Phase 5: make it selectable in the product

- [ ] Deployment target API and UI offer the registered customer-hosted providers beside Vercel, Render, and GCP.
- [ ] Host agent or Argo CD reports status by polling the AlphaCI releases API (outbound only).
- [ ] Platform hosting presets in `deploy/env`: `managed` (current) and `self-managed-compose`.
- [ ] Regenerate the provider map; mark ADR-0012 accepted.

## Done when

- A React and a .NET project each deploy to `onprem-compose` on a real Windows + WSL2 host, and the same projects still deploy to Vercel and Render when configured that way.
- Install, upgrade, rollback, and host-restart checks pass on that host.
- No CI job or AlphaCI service holds customer host or cluster credentials.
- Delete this plan.
