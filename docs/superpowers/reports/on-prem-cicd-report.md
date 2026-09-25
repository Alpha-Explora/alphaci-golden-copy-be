---
type: "Architecture Report"
title: "Connected on-premises CI/CD lean plan"
description: "Lean phased GitOps delivery plan using GitHub Team, GitHub-hosted runners, GHCR, Argo CD, Helm, and customer-operated Kubernetes."
tags: [architecture, cicd, on-premises, gitops, enterprise]
status: draft
timestamp: "2026-09-03T00:00:00+08:00"
sources:
  - id: "provider-map"
    resource: "/architecture/provider-map.generated.md"
    title: "Current Runtime provider map"
  - id: "enterprise-pack"
    resource: "/packs/enterprise/pack.md"
    title: "Current Enterprise capability status"
  - id: "runtime-source"
    resource: "src/modules/runtime"
    title: "Current Runtime provider implementation"
---

# Connected on-premises CI/CD lean plan

## Status and agreed scope

**Status:** Proposed. This is a delivery plan, not a claim that on-premises CI/CD is implemented.

- Use GitHub Team on `github.com`.
- Use GitHub-hosted Actions runners.
- Run the AlphaCI application and database in the customer environment.
- Use pull-based GitOps deployment.
- Keep Kubernetes credentials out of GitHub Actions.
- Require controlled outbound access from the customer network to GitHub and GHCR.
- Do not include GHES, self-hosted runners, or hard air-gap support yet.

## 1. Simple explanation

**GitHub builds the release; the customer cluster pulls and runs it.**

1. A developer merges approved code.
2. GitHub Actions tests the code.
3. GitHub Actions builds the frontend and backend images.
4. The images are pushed to GHCR using immutable digests.
5. Automation opens a pull request in a separate GitOps repository.
6. An authorized person approves the GitOps change.
7. Argo CD inside the customer network pulls the approved change.
8. Argo CD deploys it to Kubernetes through Helm.

```text
Code -> GitHub Actions -> GHCR image digest -> GitOps pull request
                                                   |
                                                   v
Customer network: Argo CD -> Helm -> Kubernetes -> PostgreSQL
```

The GitHub runner never connects to the Kubernetes API. Argo CD performs the deployment from inside the customer network ([Argo CD automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)).

## 2. Minimum tool list

Only the following tools are part of the baseline.

| Tool | When needed | Purpose |
|---|---|---|
| GitHub Team | Phase 0 | Source repositories, teams, rulesets, and CODEOWNERS. |
| GitHub Actions hosted runners | Phase 1 | Run tests and build release images. |
| npm with lockfiles | Phase 1 | Install frontend and backend dependencies with `npm ci`. |
| Docker Buildx/BuildKit | Phase 1 | Build reproducible container images without exposing build secrets. |
| GHCR | Phase 1 | Store frontend and backend images by immutable digest. |
| Private GitOps repository | Phase 2 | Store the approved deployment state for each environment. |
| Two GitHub Apps | Phase 2 | One opens GitOps pull requests; the other gives Argo CD read-only repository access. |
| Kubernetes | Phase 2 | Run the customer-hosted application. Use the customer's cluster; use K3s only when a small pilot needs a cluster. |
| Helm | Phase 2 | Package the frontend, backend, migrations, and background jobs as one release. |
| Argo CD | Phase 2 | Pull the approved state from GitHub and reconcile Kubernetes. |
| PostgreSQL | Phase 2 | Store application data and sessions on premises. |
| Customer ingress and TLS | Phase 2 | Provide the approved HTTPS endpoint and certificates. |
| GitHub rulesets and CODEOWNERS | Phase 2 | Protect GitOps changes and enforce accountable review. |
| Customer secret manager and secret operator | Phase 3 | Deliver runtime secrets without committing them to Git. |
| Pinned Trivy CLI/container | Phase 3 | Scan source, images, and Kubernetes configuration. |
| Cosign or customer signing service | Phase 3 | Sign and verify production image digests. |
| Customer backup system | Phase 3 | Back up PostgreSQL and prove restore. |
| Customer monitoring and logging | Phase 3 | Observe releases and alert an owner. Reuse existing tools. |

### Important GitHub Team limits

- Private GitHub Team repositories cannot use required environment reviewers. Use a protected GitOps pull request with required reviews and CODEOWNERS for production approval ([GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
- GitHub's native artifact attestations for private repositories require Enterprise Cloud. Use Cosign or a customer-approved signing service when signing is required ([GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)).
- Pin every third-party GitHub Action to a full commit SHA ([GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)).

## 3. Delivery phases

### Phase 0 — Confirm the customer prerequisites

**Goal:** Remove environmental uncertainty before implementation.

Confirm only these items:

1. Kubernetes cluster and responsible platform owner.
2. PostgreSQL service and database owner.
3. Storage class for persistent data.
4. Internal DNS name and certificate issuer.
5. Customer ingress or reverse proxy.
6. Outbound HTTPS access to `github.com`, `api.github.com`, and `ghcr.io`.
7. Whether GitHub webhooks and CI reports may use a narrow public callback endpoint.
8. Secret-management method.
9. Backup destination, retention, recovery-point objective, and recovery-time objective.
10. Production approver team and break-glass owner.

**Exit:** Every item has an answer, owner, and target date.

### Phase 1 — Build trusted images in GitHub

**Goal:** Produce one tested frontend image and one tested backend image.

Do the following:

1. Run full frontend and backend CI on pull requests.
2. Use `npm ci` from committed lockfiles.
3. Make Docker builds deterministic and move build credentials to BuildKit secret mounts.
4. Pin GitHub Actions to full commit SHAs.
5. Build images only after required tests pass.
6. Push release images to GHCR.
7. Record the image digest; do not deploy by mutable tag.

**Exit:** A commit produces reproducible, immutable frontend and backend digests in GHCR.

### Phase 2 — Deploy a non-production pilot with GitOps

**Goal:** Deploy and roll back without giving GitHub access to Kubernetes.

Do the following:

1. Create one private GitOps repository with `development`, `staging`, and `production` values.
2. Add a ruleset and CODEOWNERS so staging changes require an approved pull request.
3. Create a GitHub App that can open pull requests only in that repository.
4. Create the Helm chart for:
   - frontend Deployment and Service;
   - backend Deployment and Service;
   - database migration Job;
   - outbox worker or CronJob;
   - health probes, resource limits, and ingress configuration.
5. Install Argo CD inside the customer cluster.
6. Give Argo CD a separate read-only GitHub App for the GitOps repository.
7. Store the read-only GHCR pull credential outside Git; an out-of-band Kubernetes Secret is acceptable for staging.
8. Deploy development and staging by approved GitOps pull requests.
9. Test rollback by reverting to the previous image digests.

**Exit:** Argo CD deploys and rolls back staging while GitHub Actions has no Kubernetes credential or network path.

### Phase 3 — Make it production-ready

**Goal:** Add the controls required for a supported production release.

Do the following:

1. Protect the GitOps production branch with required reviews and CODEOWNERS.
2. Move runtime credentials into the customer secret manager.
3. Scan production images with an approved, pinned scanner artifact.
4. Sign and verify production image digests.
5. Configure PostgreSQL backups and archived transaction logs.
6. Restore a backup into a clean environment and record the result.
7. Connect application metrics and logs to the customer's existing platforms.
8. Add alerts for failed reconciliation, unhealthy pods, migration failure, database failure, and expiring credentials.
9. Write short runbooks for release, rollback, restore, and credential rotation.

**Exit:** Production approval, deploy, rollback, restore, monitoring, and secret rotation all have recorded evidence.

### Phase 4 — Add AlphaCI-managed on-premises deployments

**Goal:** Let AlphaCI deploy customer projects through the proven GitOps path.

Do the following:

1. Add an `onprem-k8s` provider pack inside Runtime.
2. Make it build images and open GitOps pull requests; it must not run `kubectl`.
3. Store GitOps repository and environment metadata, not cluster credentials.
4. Read deployment status through a narrowly scoped, read-only adapter inside the customer environment.
5. Add the on-premises provider to the frontend after the backend contract is stable.
6. Test provider generation, promotion, status, rollback, and credential boundaries.

**Exit:** An AlphaCI-managed project reaches staging through GitOps and reports status without CI holding cluster credentials.

## 4. Current blockers to fix in order

1. **Plain PostgreSQL startup:** backend startup validation still requires Supabase API configuration, and health checks ping Supabase Auth instead of PostgreSQL.
2. **Container build safety:** the backend Dockerfile passes clone/package credentials through build arguments and uses `npm install`.
3. **Automatic CI:** backend full CI is manual-only; frontend does not yet have the complete release-image workflow.
4. **Immutable workflow dependencies:** existing and generated workflows reference GitHub Actions by mutable tags.
5. **Deployment packaging:** no Helm chart, Argo CD Application, or GitOps repository exists.
6. **Connected callback decision:** existing GitHub webhook and CI-report features need a narrow public endpoint or new outbound polling behavior.
7. **Provider support:** the current [provider map](provider-map.generated.md) lists only GCP, Render, and Vercel.
8. **Frontend support:** several frontend rules still assume Render or Vercel.

Do not start the `onprem-k8s` provider before items 1–6 prove the underlying deployment path.

## 5. Ownership

### AlphaCI owns

- Source workflows and GitHub Apps.
- Frontend and backend Dockerfiles.
- Helm chart and application configuration contract.
- Database migrations and compatibility.
- The `onprem-k8s` provider.
- Product-level tests and runbooks.

### Customer owns

- Kubernetes, nodes, storage, and capacity.
- PostgreSQL operations and backups.
- DNS, certificates, ingress, firewall, and proxy rules.
- Secret manager and operational credentials.
- Monitoring, logs, alerts, and incident response.

### Joint approval

- GitOps repository access and production approvers.
- Network connections and callback mode.
- Release, rollback, restore, and support evidence.

## 6. Minimum security rules

1. GitHub Actions never receives kubeconfig or cluster-admin credentials.
2. Images are deployed by digest, not by `latest` or another mutable tag.
3. Runtime secrets never appear in GitOps values.
4. The GitOps writer and Argo CD reader use separate least-privilege GitHub App credentials.
5. Pull-request workflows do not receive production secrets.
6. Production changes require a reviewed GitOps pull request.
7. Database migrations remain compatible with the previous application release so rollback is possible.
8. Scanner actions and binaries are pinned and integrity-verified.

Trivy remains suitable only with pinned, verified patched artifacts. Its 2026 supply-chain incident makes floating tags unacceptable ([Trivy advisory](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)).

## 7. Definition of done

- [ ] Pull-request CI passes for frontend and backend.
- [ ] One source commit produces immutable frontend and backend image digests.
- [ ] A GitOps pull request promotes those exact digests.
- [ ] Argo CD deploys from inside the customer network.
- [ ] GitHub Actions has no Kubernetes credential or network access.
- [ ] Plain PostgreSQL works without Supabase API credentials.
- [ ] Database migrations and outbox processing work after restart.
- [ ] Production approval is enforced through GitOps reviews and CODEOWNERS.
- [ ] Runtime secrets come from the customer-approved secret path.
- [ ] Rollback to the previous compatible release succeeds.
- [ ] PostgreSQL restore succeeds in a clean environment.
- [ ] Alerts reach a named owner.

## 8. Not needed now

Do not add these unless a customer requirement makes them necessary:

- GHES.
- Self-hosted runners or Actions Runner Controller.
- Hard air-gap packaging.
- Harbor, unless local image custody or WAN-independent pulls are required.
- K3s when the customer already provides Kubernetes.
- Terraform or Ansible when the customer provides the cluster and network.
- SonarQube when existing CI checks satisfy the agreed quality gate.
- Argo Rollouts before standard rollout and rollback are reliable.
- A second CD engine.
- A service mesh.
- Kafka or another message broker.
- A new monitoring stack when the customer already has one.

## 9. Start here

1. Complete Phase 0 with the customer.
2. Fix plain PostgreSQL startup and container builds.
3. Complete Phase 1 image production.
4. Prove Phase 2 in staging.
5. Complete Phase 3 before production.
6. Build Phase 4 only after the GitOps path is proven.

The first milestone is simple: **GitHub produces tested image digests, an approved GitOps change promotes them, Argo CD deploys them, and the release can be rolled back without GitHub accessing Kubernetes.**
