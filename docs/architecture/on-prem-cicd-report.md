---
type: "Architecture Report"
title: "Connected on-premises CI/CD report"
description: "Proposed GitOps delivery design using GitHub Team, GitHub-hosted runners, GHCR, Argo CD, Helm, and customer-operated Kubernetes."
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
  - id: "backend-workflows"
    resource: ".github/workflows"
    title: "Current backend GitHub Actions workflows"
  - id: "runtime-source"
    resource: "src/modules/runtime"
    title: "Current Runtime provider implementation"
---

# Connected on-premises CI/CD report

## Report status

**Status:** Proposed architecture and prioritized delivery report.

This document does not claim that connected on-premises delivery is implemented. The current provider catalog contains GCP, Render, and Vercel only. GitHub Enterprise Server, managed secrets, customer-managed isolation, and air-gap packaging are recorded as not implemented in the [Enterprise pack](../packs/enterprise/pack.md).

The approved baseline for this report is:

- GitHub Team on `github.com`, not GitHub Enterprise Server.
- GitHub-hosted Actions runners, not a customer-operated runner fleet.
- Customer-hosted application runtime and data.
- Controlled outbound internet access from the customer environment.
- Pull-based GitOps deployment through Argo CD.
- No Kubernetes credentials in GitHub Actions.
- Hard air-gap support is outside the initial scope.

## 1. Executive recommendation

Use GitHub Team as the source-control and CI control plane. Build, test, scan, and publish immutable frontend and backend container images with GitHub-hosted runners. Store those images in GitHub Container Registry initially. Promote an image by opening a pull request against a separate GitOps repository. After the protected pull request is approved and merged, Argo CD inside the customer network detects the change and reconciles the customer's Kubernetes cluster through Helm.

```text
Source pull request
        |
        v
GitHub Actions hosted runner
  test -> build -> scan -> publish immutable image digest
        |
        +-----------------------> GHCR
        |
        v
GitHub App opens GitOps pull request
        |
        v
Ruleset + CODEOWNERS approval
        |
        v
GitOps main branch on github.com
        |
        | outbound pull from customer network
        v
Argo CD -> Helm -> Kubernetes -> frontend/API/jobs
                              |
                              v
                         PostgreSQL
```

This is the recommended design because the hosted runner never needs network access to the customer cluster and never receives a kubeconfig. Argo CD documents this exact separation: CI commits desired state to Git, while Argo CD performs reconciliation without exposing its API server to the pipeline ([Argo CD automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)).

### Decision summary

| Decision | Selected baseline | Reason |
|---|---|---|
| Source control | GitHub Team on `github.com` | Matches the current organization and avoids operating GHES. |
| CI execution | GitHub-hosted runners | Fastest path; current workflows already use `ubuntu-latest`. |
| Deployment style | GitOps pull | Keeps cluster credentials and direct cluster reachability out of CI. |
| Deployment authority | Protected GitOps repository | A reviewed desired-state change is the production release record. |
| Runtime packaging | Two OCI images plus one Helm chart | Keeps frontend and backend independently observable while using one release definition. |
| Initial registry | Private GHCR packages | Native to GitHub Actions and does not require GitHub runners to reach the customer network. |
| Runtime platform | Customer Kubernetes; K3s for a small AlphaCI-managed pilot and RKE2/existing Kubernetes for production | Avoids forcing a new cluster when the customer already has one. |
| Database | Customer PostgreSQL or CloudNativePG | Keeps application data on premises. |
| Secrets | Customer secret manager through an operator; SOPS only as a fallback | Prevents plaintext secrets in Git and keeps custody with the customer. |
| Production approval | Protected GitOps pull request with required reviews and CODEOWNERS | GitHub Team does not provide environment required reviewers for private repositories. |

## 2. Scope

### 2.1 Included

The report covers two connected delivery streams:

1. **AlphaCI platform delivery** — build and deploy the AlphaCI frontend, backend, database migrations, and background jobs into a customer-operated environment.
2. **AlphaCI-managed project delivery** — add an `onprem-k8s` Runtime provider so AlphaCI-generated workflows can publish project images and request GitOps promotions without receiving cluster credentials.

Platform delivery comes first. The provider cannot be proven until the platform chart, GitOps repository, and customer cluster path work independently.

### 2.2 Excluded from the first delivery

- GitHub Enterprise Server.
- Actions Runner Controller and self-hosted runners.
- Hard air-gap or removable-media packaging.
- Direct `kubectl` or Helm execution from GitHub-hosted runners.
- A public Kubernetes API endpoint for CI.
- Multiple CD engines; Argo CD is the baseline and Flux is not implemented in parallel.
- A service mesh, Kafka, or another broker.
- Canary delivery through Argo Rollouts.
- A mandatory internal registry when the customer permits controlled GHCR pulls.

## 3. How the delivery works

### 3.1 Continuous integration

For each frontend or backend pull request:

1. GitHub starts an ephemeral GitHub-hosted runner.
2. The runner installs dependencies from the committed lockfile.
3. It runs repository-specific type checks, linting, tests, architecture checks, and documentation checks.
4. It builds the container image without pushing it.
5. It validates the Helm chart with `helm lint`, renders it with `helm template`, validates the rendered resources with `kubeconform`, and installs it into a disposable `kind` cluster for a smoke test.
6. It scans source and the final image. The selected scanner must be pinned and integrity-verified.
7. Required checks report back to the protected source branch.

No deployment credentials are available in pull-request jobs. Workflows triggered from forks must never receive repository or environment secrets.

### 3.2 Release image creation

After an approved source change reaches the release branch:

1. GitHub Actions rebuilds the same source revision in a release job.
2. Docker Buildx/BuildKit produces the production image.
3. The job pushes the image to GHCR using the repository-scoped `GITHUB_TOKEN` with `packages: write`.
4. The workflow records the immutable `sha256` digest. Tags remain human-readable aliases and are never the deployment identity.
5. The image is scanned and an SBOM is attached or stored with the release evidence.
6. The release is signed with the approved Cosign mode before production use.

GitHub documents the GHCR build-and-publish path with Buildx and `GITHUB_TOKEN` ([publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)). Private packages can be pulled by digest; cluster pull credentials must have read-only package access ([GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)).

### 3.3 Promotion through the GitOps repository

Use one private repository dedicated to desired deployment state, for example `Alpha-Explora/alphaci-deployments`.

```text
apps/
  alphaci/
    chart/
    environments/
      development/values.yaml
      staging/values.yaml
      production/values.yaml
    applications/
      development.yaml
      staging.yaml
      production.yaml
```

The exact repository can keep the chart beside the values or reference a chart published as an OCI artifact. The first implementation should keep the chart and values together because it reduces authentication and version-coordination failure modes.

Promotion behaves as follows:

- Development: the release workflow may open and auto-merge a GitOps pull request after all checks pass.
- Staging: the workflow opens a pull request; one authorized reviewer approves it.
- Production: the workflow opens a pull request changing only the approved image digest and release metadata; required reviews and CODEOWNERS approval are mandatory.
- Rollback: revert the GitOps commit to the last known-good digest. Argo CD reconciles that state. Database rollback remains governed by migration compatibility, not only by image rollback.

The GitOps writer is a GitHub App installation token scoped only to contents and pull-request operations on the GitOps repository. It must not be a broad personal access token.

### 3.4 Deployment inside the customer network

Argo CD polls the private GitOps repository over outbound HTTPS using a separate read-only GitHub App credential. Argo CD supports GitHub App authentication for private GitHub repositories ([Argo CD private repository authentication](https://argo-cd.readthedocs.io/en/latest/user-guide/private-repositories/)).

After a promotion is merged:

1. Argo CD detects the changed digest.
2. Helm renders the environment values.
3. A migration job runs under an explicit sync phase before application traffic is shifted.
4. Kubernetes rolls out the backend and frontend Deployments.
5. Readiness probes prevent unready pods from receiving traffic.
6. The outbox processor runs as a Kubernetes CronJob or continuously supervised worker, according to the selected operating model.
7. Argo CD records health and sync status.
8. Monitoring confirms the release service-level checks.

Production synchronization may be automatic after a protected merge. The protected GitOps pull request is the approval gate; adding an Argo manual click creates a second gate without improving the evidence trail.

### 3.5 GitHub callbacks and CI reports

Pull-based deployment does not require GitHub-hosted runners to reach the customer network. AlphaCI's live GitHub integration is a separate concern: GitHub webhooks and existing CI report callbacks require an internet-reachable endpoint if they remain push-based.

The initial network decision must select one of these modes:

| Mode | Recommendation | Consequence |
|---|---|---|
| Narrow callback ingress | Default for the first connected install | Expose only the webhook and CI-report routes through the customer's reverse proxy or WAF. Require HMAC or project-token authentication, TLS, rate limits, and complete audit logs. |
| Outbound polling | Use when the customer forbids public callbacks | Add a backend poller using the GitHub API. Do not claim real-time webhook behavior until this is implemented and tested. |
| Private runner networking | Defer | GitHub supports several private-networking approaches, but this adds network coupling that GitOps does not need ([GitHub-hosted runner private networking](https://docs.github.com/en/actions/concepts/runners/private-networking)). |

The callback hostname must not expose the Kubernetes API, Argo CD administration, PostgreSQL, or the customer secret manager.

## 4. Tool inventory

The classifications below prevent the team from installing every possible platform tool. **Required now** means it is part of the first working path. **Required before production** means a pilot can start without it but production acceptance cannot. **Conditional** means use it only when the customer does not already provide the capability or when the associated requirement exists.

### 4.1 GitHub control plane and governance

| Tool or capability | Priority | Owner | Purpose and decision |
|---|---|---|---|
| GitHub Team organization | Required now | AlphaCI | Private source, reusable workflow, and GitOps repositories; teams; rulesets; CODEOWNERS. |
| GitHub Actions hosted runners | Required now | GitHub | Execute CI, image publication, and GitOps pull-request creation. They do not deploy to Kubernetes. |
| Existing central workflow repository | Required now | AlphaCI | Own reusable quality, image, and promotion workflows. Version every reusable workflow by immutable commit SHA or reviewed release reference. |
| Private GitOps repository | Required now | Joint | Single auditable desired-state source for development, staging, and production. |
| GitHub App for GitOps writes | Required now | AlphaCI | Short-lived installation token with write access only to GitOps contents and pull requests. |
| GitHub App for Argo CD reads | Required now | Customer | Separate read-only installation with access only to the GitOps repository. |
| Repository rulesets | Required now | AlphaCI | Require pull requests, required status checks, approval count, stale-review dismissal, and branch deletion protection. GitHub Team supports rulesets in private repositories ([GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)). |
| CODEOWNERS | Required now | Joint | Route environment changes to accountable approvers and require code-owner review ([GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)). |
| GitHub Environments | Required now, limited role | AlphaCI | Store environment-scoped variables/secrets and restrict deployment branches. Do not use them as the human production gate on private GitHub Team repositories. |
| Dependabot | Required before production | AlphaCI | Maintain application and action dependencies; updates still pass normal review and verification. |

#### GitHub Team limitation that affects the design

For private repositories, GitHub Team provides environments, environment secrets, and deployment-branch restrictions, but required environment reviewers and wait timers are only available for public repositories. Production approval must therefore be a protected GitOps pull request rather than an assumed environment-review gate ([GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).

GitHub's native artifact attestations are also unavailable to private repositories on GitHub Team; private-repository attestations require GitHub Enterprise Cloud. The baseline therefore uses Cosign or a customer-approved signing service rather than claiming native GitHub attestations ([GitHub artifact-attestation availability](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)).

### 4.2 Build, test, and supply-chain tools

| Tool | Priority | Owner | Purpose and decision |
|---|---|---|---|
| npm with committed lockfiles | Required now | AlphaCI | Reproducible frontend and backend dependency installation through `npm ci`. |
| Docker Buildx/BuildKit | Required now | AlphaCI | Multi-stage, cached, secret-safe image builds on GitHub-hosted runners. |
| GHCR | Required now | AlphaCI | Initial private OCI registry. Deploy only immutable digests. |
| Helm | Required now | AlphaCI | Package frontend, backend, migration job, outbox job, Services, ingress settings, probes, policies, and resource requests as one release. |
| kubeconform | Required now | AlphaCI | Validate rendered Kubernetes resources against schemas in CI. |
| kind | Required now | AlphaCI | Install the chart into an ephemeral cluster during CI without reaching the customer network. |
| Trivy CLI or pinned container | Required before production | AlphaCI | Scan source, images, secrets, and Kubernetes configuration; generate an SBOM when selected. |
| Cosign | Required before production | Joint | Sign release image digests. Select keyless signing only if its transparency metadata is acceptable; otherwise use a customer-approved key service. |
| k6 | Conditional | AlphaCI | Run a repeatable smoke/performance gate against staging. |
| SonarQube or SonarCloud | Conditional | Joint | Add only when the customer requires this quality system. It is not a prerequisite for the deployment path. |

All actions must be pinned to full commit SHAs. GitHub identifies full-length commit pinning as the immutable way to consume an action ([GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)).

Trivy requires an additional safeguard because its release and Actions ecosystem had a documented supply-chain compromise in March 2026, and versions before `0.71.1` also contain a later path-traversal issue. Do not use `latest` or a floating action tag. Use an approved patched release, verify its checksum or signature, and pin the action and container by full SHA/digest ([Trivy incident advisory](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23), [Trivy path-traversal advisory](https://github.com/aquasecurity/trivy/security/advisories/GHSA-mcj4-mphf-j9ff)).

### 4.3 Customer-hosted runtime and delivery tools

| Tool or slot | Priority | Owner | Purpose and decision |
|---|---|---|---|
| Existing Kubernetes, RKE2, or K3s | Required now | Customer | Run the application. Prefer the customer's supported cluster; use K3s only for a small managed pilot and RKE2/existing Kubernetes for production. |
| Argo CD | Required now | Customer | Pull desired state from GitHub and reconcile the cluster. |
| Helm chart | Required now | AlphaCI | Supported installation and release contract. The chart must remain distribution-neutral. |
| Customer ingress or ingress-nginx | Required now | Customer | HTTPS entry point for UI/API and, when selected, narrow GitHub callbacks. |
| Customer DNS | Required now | Customer | Stable application and callback hostnames. |
| cert-manager or customer certificate automation | Required now | Customer | Issue and rotate certificates from the customer's approved CA. |
| Kubernetes RBAC and NetworkPolicy | Required before production | Joint | Give Argo CD and workloads only their required namespace and network permissions. |
| Kyverno or the customer's policy engine | Required before production when no equivalent exists | Customer | Enforce non-root pods, approved registries, digest-pinned images, resource limits, and prohibited privilege. |
| Harbor | Conditional | Customer | Add when images must be retained on premises, WAN-independent pulls are required, or customer policy forbids direct GHCR pulls. Use pull/replication from inside the customer network. |
| Argo Rollouts | Conditional | Customer | Add only after ordinary rolling deployments are reliable and canary or blue/green rollout is required. |
| Ansible | Conditional | AlphaCI or customer | Bootstrap K3s/RKE2 and OS prerequisites only when AlphaCI owns the VM installation. |
| Terraform/OpenTofu | Conditional | AlphaCI or customer | Provision VMs, DNS, or load balancers only when the customer's infrastructure exposes a supported API. It is not part of the application chart. |

`kubectl` is a bootstrap, diagnosis, and break-glass tool. It is not the normal production deployment mechanism. Helm supports repeatable upgrade and rollback operations, but the GitOps commit remains the authoritative release record ([Helm upgrade and rollback](https://docs.helm.sh/docs/intro/using_helm/)).

### 4.4 Data, secrets, and recovery tools

| Tool or slot | Priority | Owner | Purpose and decision |
|---|---|---|---|
| Customer PostgreSQL | Required now | Customer | Primary application database and PostgreSQL-backed session store. |
| CloudNativePG | Conditional default | Customer | Operate PostgreSQL in Kubernetes when the customer does not provide a managed PostgreSQL service. |
| PgBouncer | Conditional | Customer | Add when measured connection pressure or failover behavior requires pooling. |
| Vault, OpenBao, or customer secret manager | Required before production | Customer | Custody for database, GitHub App, encryption, SMTP, and registry credentials. Reuse an existing service when available. |
| Vault Secrets Operator or External Secrets Operator | Required before production | Customer | Materialize or mount runtime secrets without committing plaintext to Git. |
| SOPS with age | Conditional fallback | Joint | Use only when no external secret manager exists. Keep decryption keys outside Git and document rotation. |
| Customer object storage or MinIO | Required before production when operating PostgreSQL | Customer | Store physical database backups and archived WAL away from the active database volumes. |
| Barman Cloud plugin for CloudNativePG | Conditional default | Customer | Continuous backup and point-in-time recovery when CloudNativePG is selected. CloudNativePG is moving object-store backup toward the plugin model ([CloudNativePG backup guidance](https://github.com/cloudnative-pg/cloudnative-pg/blob/main/docs/src/backup.md)). |
| Velero | Conditional | Customer | Back up Kubernetes-owned configuration and persistent volumes not already protected by an application-specific mechanism. It does not replace PostgreSQL-aware backup. |

### 4.5 Observability and operations tools

| Tool or slot | Priority | Owner | Purpose and decision |
|---|---|---|---|
| Prometheus-compatible metrics | Required before production | Customer | Scrape application and cluster health metrics. Reuse the customer's platform where possible. |
| Grafana or customer dashboarding | Required before production | Customer | Release, capacity, and service-health dashboards. |
| Vector or Fluent Bit | Required before production | Customer | Forward structured container logs to the customer's approved sink. |
| Loki, Elastic, or Splunk | Conditional | Customer | Log storage/search; choose the customer's existing platform rather than shipping a duplicate by default. |
| OpenTelemetry Collector | Required before production | Joint | Standard path for traces and correlated telemetry. |
| Alertmanager or customer incident platform | Required before production | Customer | Route actionable alerts to the owned support channel. |
| Support-bundle script | Required before production | AlphaCI | Collect versions, Argo status, workload health, migration state, and redacted logs without exporting secrets. |

## 5. Network and trust boundaries

### 5.1 Required connections

| Source | Destination | Direction | Authentication | Purpose |
|---|---|---|---|---|
| Developer browser | GitHub | Outbound | GitHub identity | Source review and GitOps approval. |
| GitHub-hosted runner | GitHub API and GHCR | Public internet | `GITHUB_TOKEN` and short-lived GitHub App token | Read source, publish image, open GitOps pull request. |
| GitHub-hosted runner | Customer Kubernetes API | **No connection** | **None** | Deliberately prohibited. |
| Argo CD | GitHub GitOps repository | Customer outbound TCP 443 | Read-only GitHub App installation | Poll desired state. |
| Kubernetes node or Harbor | GHCR | Customer outbound TCP 443 | Read-only package credential | Pull immutable images. |
| User browser | Customer ingress | Inbound TCP 443 | AlphaCI session | Use the product. |
| GitHub webhook or hosted CI callback | Narrow callback ingress | Optional inbound TCP 443 | HMAC or project token | Live GitHub events and CI reporting. |
| Backend | GitHub API | Customer outbound TCP 443 | GitHub App or OAuth token | Repository and workflow operations. |
| Backend | PostgreSQL | Customer internal TCP 5432 | Customer secret | Application data and sessions. |
| Workloads | Secret manager | Customer internal HTTPS | Kubernetes workload identity | Runtime secret retrieval. |
| Workloads | Telemetry collectors | Customer internal | Service identity or internal policy | Logs, metrics, and traces. |

### 5.2 Credential rules

1. No kubeconfig, cluster token, Argo administrator token, or database credential is stored in GitHub Actions for deployment.
2. The release job uses `GITHUB_TOKEN` only for its own source repository and GHCR package.
3. A dedicated GitHub App opens GitOps pull requests. Its installation is limited to the GitOps repository.
4. Argo CD uses a different read-only GitHub App credential.
5. The cluster's GHCR pull credential is read-only, stored in the customer secret manager, and rotated. Move to Harbor if customer policy rejects this long-lived external-registry credential.
6. Runtime secrets never appear in Helm values committed to Git.
7. Workflow permissions start at `contents: read`; each job adds only the permissions it needs.
8. Pull-request jobs do not receive release secrets.

## 6. Production approval under GitHub Team

Because private GitHub Team repositories cannot use required environment reviewers, protect the production directory in the GitOps repository itself:

```text
/apps/alphaci/environments/production/  @Alpha-Explora/platform-approvers
/.github/                               @Alpha-Explora/platform-owners
```

The production ruleset should require:

- A pull request for every change.
- At least two approvals for production.
- CODEOWNERS approval.
- Dismissal of stale approvals after a new commit.
- Approval of the most recent reviewable push.
- Required image, chart, policy, and manifest checks.
- Resolution of all blocking review threads.
- No branch deletion or force push.
- Restricted bypass membership with an audited break-glass procedure.
- A GitHub App as the only automated pull-request author.

The GitOps pull request should show the source commit, image digest, scan result, SBOM location, migration compatibility result, and rollback digest. An approver must be able to decide without reading CI logs end to end.

## 7. Current repository gaps

The following findings are from the backend `main` revision `84944116b441ed82454c347eeb6e1e010f1af15f` and frontend `main` revision `8ce4016` inspected on 2026-09-03.

| Priority | Current evidence | Required correction |
|---|---|---|
| P0 | The [provider map](provider-map.generated.md) contains only `gcp`, `render`, and `vercel`; `onprem-k8s` is absent. | Add the provider only after the platform GitOps path is proven. |
| P0 | The Enterprise capability catalog marks GHES, managed secrets, air-gap packaging, and customer isolation as not implemented. | Keep those claims unchanged until implementation and operational evidence exist. GHES and air-gap remain out of this delivery. |
| P0 | No Helm chart, Argo CD Application, or Kubernetes workload manifests exist in the backend or frontend repository. | Create a chart and GitOps bootstrap structure. |
| P0 | Backend startup validation still requires Supabase API credentials or a scoped Supabase client, while the main data path uses PostgreSQL. Health checks call the Supabase Auth API instead of checking PostgreSQL. | Permit a plain PostgreSQL operating mode and make readiness test the real database dependency. |
| P0 | The backend Dockerfile clones the workflow-template repository during image build using token build arguments and runs `npm install`. | Use BuildKit secret mounts or pre-fetched build context, remove credential-bearing URLs from build steps, and use `npm ci`. |
| P0 | Backend `.github/workflows/ci.yml` is manual-only. | Run required CI on pull requests and protected-branch pushes, with a separate explicit release workflow. |
| P1 | Repository workflows and generated workflows reference actions by mutable version tags. | Pin every third-party action to a reviewed full commit SHA and automate reviewed updates. |
| P1 | Generated workflows use `ubuntu-latest`. | Retain this for the selected hosted-runner baseline; make the runner label configurable only for a later self-hosted option. |
| P1 | Generated deployment fragments target Render and Vercel, with GCP composed separately. | Add a provider-owned GitOps fragment that publishes an image and opens a deployment pull request rather than calling Kubernetes. |
| P1 | Central reusable-workflow repository ownership is embedded in workflow-generation code. | Make owner, repository, and immutable reference explicit configuration and validate them. |
| P1 | The frontend Dockerfile exists, but there is no complete frontend build-and-publish/release workflow or shared chart. | Add the same digest-based release contract as the backend. |
| P1 | Frontend provider presentation assumes Render or Vercel in several rules and URLs. | Add provider-neutral on-prem presentation after the backend provider contract is stable. |
| P1 | Existing GitHub webhooks and CI-report callbacks assume a reachable backend. | Select narrow callback ingress or implement polling before enabling live reporting. |
| P2 | No committed backup/restore, signing, admission-policy, or customer-cluster acceptance evidence exists. | Add runbooks and execute controlled production-readiness drills. |

The existing provider boundary is reusable: according to the [provider ADR](decisions/adr-0004-provider-and-port-boundaries.md), the on-prem adapter belongs inside Runtime and must expose provider-neutral contracts. It must not become a new top-level product area.

## 8. Prioritized implementation program

### P0 — Resolve blockers and freeze contracts

Complete these before building cluster automation:

1. Confirm the customer's Kubernetes ownership, supported distribution/version, storage class, ingress, DNS, CA, PostgreSQL, secret manager, object storage, and outbound proxy rules.
2. Confirm whether live GitHub callbacks may use a narrow public endpoint. Select polling when they may not.
3. Define the GitOps repository, environment directories, approver teams, CODEOWNERS, and bypass policy.
4. Confirm direct GHCR pull is permitted for the pilot. If not, move Harbor into P1.
5. Define recovery objectives: recovery point, recovery time, backup retention, and restore-test frequency.
6. Add a plain PostgreSQL startup and health contract; remove the false requirement for Supabase API health when Supabase is not selected.
7. Define one release manifest containing source SHA, frontend digest, backend digest, chart version, schema compatibility, and rollback digest.

**Exit evidence:** signed customer prerequisites, approved network matrix, approved GitOps protection settings, plain-PostgreSQL boot test, and release-manifest schema.

### P1 — Produce a repeatable deployable pilot

1. Harden both Dockerfiles for deterministic, secret-safe `npm ci` builds.
2. Add pull-request CI for backend and full CI for frontend.
3. Pin all action dependencies by full SHA.
4. Build and publish frontend and backend images to GHCR by digest.
5. Create the Helm chart with Deployments, Services, probes, resource requests/limits, PodDisruptionBudgets where meaningful, migration Job, and outbox CronJob/worker.
6. Validate the chart with Helm, kubeconform, and kind in GitHub Actions.
7. Create the GitOps repository and GitHub App writer.
8. Install Argo CD in a non-production customer cluster with read-only GitHub App access.
9. Deploy development and staging through protected GitOps pull requests.
10. Demonstrate a rollback to the prior image digest.

**Exit evidence:** a source pull request produces immutable images, a GitOps pull request promotes them, Argo CD deploys them without CI cluster credentials, smoke tests pass, and a rollback succeeds.

### P2 — Make the pilot production-capable

1. Integrate the customer secret manager and remove plaintext runtime secrets from Git and manually managed cluster objects.
2. Add signed image verification. Because private GitHub Team repositories cannot use GitHub artifact attestations, approve a Cosign or customer signing design explicitly.
3. Add hardened image scanning with pinned, verified scanner artifacts and a documented exception process.
4. Enforce namespace RBAC, NetworkPolicy, non-root execution, read-only filesystems where supported, approved registries, and digest-only images.
5. Configure PostgreSQL physical backup, WAL archiving, retention, encryption, and a separate recovery location.
6. Execute a full restore drill into a clean database/namespace and record measured recovery time and recovery point.
7. Add metrics, structured logs, traces, dashboards, and actionable alerts.
8. Add a support bundle and operational runbooks for deploy, rollback, migration failure, expired GitHub credentials, registry outage, database failure, and Argo drift.
9. Run load, failover, upgrade, and rollback tests against the customer-like staging environment.

**Exit evidence:** production approval controls are enforced, signatures are verified, restore and rollback drills pass, alerts reach an owner, and operating runbooks have named owners.

### P3 — Add AlphaCI-managed on-prem project delivery

1. Add the `onprem-k8s` provider pack under Runtime using the existing provider contract.
2. Make it emit provider-owned GitOps workflow fragments rather than Kubernetes commands.
3. Add target configuration for GitOps repository, application path, registry namespace, and environment policy without storing cluster credentials.
4. Read deployment status through a narrowly scoped Argo CD or Kubernetes read adapter inside the customer environment.
5. Extend the frontend with provider-neutral configuration and status views.
6. Add provider conformance, workflow-generation, GitOps pull-request, drift, rollback, and live staging tests.

**Exit evidence:** an AlphaCI-managed project builds on a GitHub-hosted runner, opens a protected GitOps promotion, deploys through Argo CD, and reports status without AlphaCI or GitHub Actions owning cluster-admin credentials.

### P4 — Add only when required

- Harbor replication or pull-through cache for local image custody and WAN resilience.
- Highly available RKE2 or customer cluster profile.
- Additional Argo CD clusters and environment isolation.
- Argo Rollouts for canary/blue-green delivery.
- Self-hosted runners and ARC for private builds or specialized hardware.
- GHES and action mirroring.
- Air-gap export/import tooling.
- A dedicated self-hosted code-quality platform.
- A larger SBOM inventory/governance platform.

## 9. Responsibility split

| Area | AlphaCI | Customer | Joint acceptance |
|---|---|---|---|
| Application images | Build definitions, patching policy, SBOM, signatures | Permit approved registry access or mirror images | Digest and signature verification |
| Helm release | Chart, defaults, upgrades, migrations, probes | Environment values and platform integrations | Install and rollback test |
| GitHub | Workflows, Apps, rulesets, generated delivery contract | Approver identities and customer repository access | Least-privilege review |
| Kubernetes | Supported workload contract | Cluster, nodes, storage, ingress, RBAC, policy | Capacity and failure test |
| PostgreSQL | Schema migrations and compatibility | Availability, backup, restore, credentials | Restore and migration drill |
| Secrets | Secret names and rotation behavior | Secret manager and custody | Rotation test without outage |
| Networking | Required connection matrix | Firewall, proxy, DNS, certificates, WAF | Connectivity and denial tests |
| Operations | Product dashboards, alerts, support bundle, runbooks | Monitoring stack and incident process | Alert and support exercise |

Every unresolved customer prerequisite requires an owner and target date. A tool name without an operator, backup owner, patch owner, and recovery procedure is not a production capability.

## 10. Failure handling and rollback

| Failure | Expected behavior | Recovery owner |
|---|---|---|
| CI quality check fails | No image is published or promoted. | AlphaCI engineering |
| Image build or scan fails | No GitOps pull request is opened. | AlphaCI engineering |
| GitOps checks fail | Pull request cannot merge. | Change author |
| Argo cannot read GitHub | Existing workloads continue; alert on stale reconciliation. | Customer platform |
| GHCR cannot be reached | Existing pods continue; new scheduling may fail. Add Harbor when WAN independence is required. | Joint |
| Migration job fails | Application rollout remains blocked; do not retry destructive migrations blindly. | AlphaCI engineering and DBA |
| Readiness fails | Kubernetes does not route traffic to the new pods; Argo reports degraded health. | Joint |
| Application regression | Revert the GitOps digest after confirming schema compatibility. | Release approver |
| Database failure | Restore or fail over according to the tested PostgreSQL runbook. | Customer DBA/platform |
| GitHub App credential expires or is revoked | GitOps write/read fails closed; rotate through the customer secret process. | Joint |

Database changes must use expand-and-contract compatibility. An image rollback is not safe when the schema migration removed or reinterpreted data needed by the earlier image.

## 11. Verification and acceptance checklist

### Source and CI

- [ ] Backend and frontend CI run automatically on pull requests.
- [ ] Required checks protect the release branches.
- [ ] All third-party actions use full commit SHAs.
- [ ] `npm ci` succeeds from committed lockfiles.
- [ ] Docker builds receive secrets through BuildKit secret mechanisms, not credential-bearing clone URLs or copied `.npmrc` files.
- [ ] Source, image, and Kubernetes configuration scans have an owned severity policy.
- [ ] Helm lint, template validation, and kind installation pass.

### Artifact and promotion

- [ ] Images are published once and promoted by digest without rebuilding per environment.
- [ ] Frontend and backend release digests are recorded together.
- [ ] SBOM and scan evidence are attached to the release record.
- [ ] Production images are signed and verified using the approved mode.
- [ ] Only the dedicated GitHub App can automate GitOps pull requests.
- [ ] Production changes require protected GitOps pull requests and CODEOWNERS approval.

### Customer runtime

- [ ] Argo CD can read GitHub but GitHub Actions cannot reach the Kubernetes API.
- [ ] Workloads run without root and with explicit resources, probes, and restricted service accounts.
- [ ] Plain PostgreSQL startup and health checks work without Supabase API credentials.
- [ ] PostgreSQL sessions, application traffic, migrations, and outbox processing work after pod restart.
- [ ] Secrets come from the customer-approved secret path and can be rotated.
- [ ] The selected callback or polling mode works and fails closed.

### Recovery and operations

- [ ] Reverting a GitOps commit restores the previous compatible image.
- [ ] A failed migration blocks rollout safely.
- [ ] A clean database restore from protected backup succeeds.
- [ ] Recovery time and recovery point are measured against the approved objectives.
- [ ] Alerts reach a named support owner.
- [ ] The support bundle excludes secrets and is usable without cluster-admin access.
- [ ] The release and rollback runbooks have been executed by someone other than their author.

## 12. Risks and controls

| Risk | Impact | Control |
|---|---|---|
| GitHub.com or GHCR outage | New builds/promotions stop; new pods may fail to pull. | Existing workloads remain running; add Harbor when WAN-independent pulls are a requirement. |
| GitHub-hosted runner compromise | Source/build secret exposure or malicious artifact. | Least permissions, isolated release jobs, SHA-pinned actions, verified tools, digest/signature verification, and no cluster credentials. |
| GitHub Team approval limitations | A false belief that private environment reviewer gates exist. | Enforce approval in the protected GitOps repository. |
| Long-lived GHCR pull credential | Package credential theft from cluster. | Read-only scope, customer secret manager, rotation, namespace isolation, and Harbor when required. |
| Scanner supply-chain compromise | Security tooling becomes an attack path. | Pin full SHA/digest, verify checksums/signatures, track advisories, and isolate scanner permissions. |
| Public callback endpoint | Expanded attack surface. | Expose only narrow authenticated routes through WAF/rate limits, or implement outbound polling. |
| Database migration incompatibility | Rollback cannot restore service. | Expand-and-contract migrations, compatibility checks, backup, and restore rehearsal. |
| Customer platform variation | Install works in one cluster but not another. | Distribution-neutral Helm chart, declared support matrix, and customer-like acceptance environment. |
| Unowned optional tools | Patch, backup, and incident gaps. | Integrate with customer-owned services and record operational ownership before enabling each tool. |

## 13. What should not be purchased or built now

Do not make these part of the initial budget or critical path:

- A GHES appliance.
- ARC and a self-hosted runner fleet.
- MinIO solely for GitHub Actions artifacts or cache.
- Action mirroring and disconnected npm mirrors.
- Harbor when direct GHCR pulls meet the customer's policy and availability requirement.
- Both Argo CD and Flux.
- Argo Rollouts before ordinary rollout and rollback are dependable.
- A service mesh.
- Kafka or NATS for the current PostgreSQL outbox.
- A separate observability stack when the customer already has one.
- Air-gap packaging products.

These items can become valid when a measured requirement appears. Adding them now increases installation, patching, backup, and support obligations without proving the first deployment path.

## 14. Immediate next actions

In priority order:

1. Review and approve this report as the connected on-premises baseline.
2. Complete the P0 customer prerequisite and network worksheet.
3. Define the release manifest and GitOps repository contract.
4. Remove the backend's mandatory Supabase API startup/health dependency for plain PostgreSQL mode.
5. Harden both image builds and enable automatic pull-request CI.
6. Create and test the Helm chart in kind.
7. Create the protected GitOps repository and least-privilege GitHub Apps.
8. Prove development and staging deployment through Argo CD.
9. Prove rollback, migration failure handling, and database restore.
10. Add the `onprem-k8s` provider only after the underlying path is operational.

The first meaningful milestone is not “Argo CD is installed.” It is: **a reviewed source revision produces immutable artifacts, a protected GitOps change promotes them, the customer cluster deploys them without CI cluster credentials, and the release can be rolled back with recorded evidence.**
