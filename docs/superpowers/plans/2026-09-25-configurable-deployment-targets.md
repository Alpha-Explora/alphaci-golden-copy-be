# Configurable deployment targets: on-premises setup

**Goal:** Make deployment a setting. Managed providers (Vercel, Render, GCP)
stay the default; customer-hosted Compose (Windows + WSL2 first) and
Kubernetes become options for both the AlphaCI platform and the projects it
deploys. Decision: [ADR-0012](../../architecture/decisions/adr-0012-configurable-deployment-targets.md).
Step-by-step host setup, from the test laptop to an enterprise client:
[on-prem client setup guide](2026-09-25-onprem-client-setup-guide.md).

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

### Phase 0: decide

- [x] First workload: customer React and .NET projects (product owner, 2026-09-25).
- [x] Connectivity: connected, pulling from GHCR (product owner, 2026-09-25).
- [x] Path: `onprem-compose` first; `onprem-k8s` later, for clients that already run Kubernetes.
- [x] Hosts: our Windows 11 laptop, then one Windows Server 2022 VM, then the first client. Client distro Ubuntu 24.04 LTS.
- [x] Signing: Cosign with an AlphaCI key in Cloud KMS; hosts get only the public key.
- [x] Remaining defaults (ingress, ports, secrets, status, environments): see "Chosen defaults" in the setup guide.

### Phase 1: test host on our laptop

- [x] Turn off Docker Desktop WSL integration for `Ubuntu` and install Docker Engine inside it. Evidence: `/usr/bin/docker`, Ubuntu Engine, Compose and Buildx versions, and `hello-world` run on 2026-09-25.
- [x] Confirm Ubuntu Engine and systemd Docker service; keep WSL networking on NAT. Evidence: `docker info` reports Ubuntu 26.04.1, `systemctl is-active docker` reports active, and `.wslconfig` has no networking override (2026-09-25).
- [x] Create `/opt/alphaci/{bin,trust,secrets,tls,releases}`. Evidence: root-owned directories and `secrets/` mode 700, checked 2026-09-25.
- [ ] Add test trust, TLS, and secret files once signing, release publishing, and host credentials exist.

### Phase 2: images and signed releases (Compose first)

- [ ] Add a React Dockerfile (static build + nginx or Caddy) to the React scaffold.
- [ ] Add `onprem-artifact-build.yml` to `alphaci-workflow`: build, Trivy scan, SBOM, push to GHCR, output digests.
- [ ] Add `onprem-release-publish.yml`: write a Cosign-signed manifest (FE/BE digests, migration version, release id). No host or cluster credentials.

### Phase 3: Compose target (default customer-hosted path)

- [ ] `alphaci-agent` inside WSL: poll the releases API, verify the manifest signature with the pinned key, pull by digest, `docker compose up -d`, check health, roll back on failure, report status, export a support bundle.
- [ ] `Install-AlphaCIHost.ps1`, safe to rerun: scheduled task as the service account, portproxy refresh, firewall rule scoped to client subnets.
- [ ] Caddy in the Compose stack with the client's certificate.
- [ ] Register the `onprem-compose` provider pack and workflow fragment in Runtime.
- [ ] Pass the guide's acceptance checks on the laptop, then on a Windows Server 2022 VM with nested virtualization.
- [ ] Move the setup guide to `docs/runbooks/runbook-onprem-client-setup.md` and drop its "proposed" labels.

### Phase 4: Kubernetes lab (later; clients that already run Kubernetes)

- [ ] Package the Helm chart (`helm package`, `helm push <chart>.tgz oci://ghcr.io/<org>/charts`).
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
