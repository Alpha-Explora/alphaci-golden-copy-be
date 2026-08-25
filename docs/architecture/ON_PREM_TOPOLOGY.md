# AlphaCI Enterprise — On-Prem Topology and Tool Inventory

**Status:** proposed. Nothing here is landed.
**Companion to:** `FUTURE_STATE.md` — this document answers its open decisions
1 (runtime platform), 2 (who operates), 3 (per-tenant GitHub App) and 5
(Supabase or plain Postgres), and the "SCM / CI axis" flagged in
`../modular-architecture-deployments.md` §12.3.
**Scope:** the infrastructure a single enterprise install needs, which tool fills
each slot, and every connection between them. It does not restructure
application code — it consumes the bundled/split composition root from
`FUTURE_STATE.md` §3 as-is.

---

## 0. The two forks that decide everything else

Every tool choice below hangs off these. Answer them before drawing anything.

| # | Fork | Options | Recommended default |
|:-:|------|---------|---------------------|
| A | **Where does GitHub live?** | GitHub Enterprise Server appliance inside the customer network **/** github.com (EMU) with self-hosted runners only | **Design for GHES, degrade to github.com.** GHES is the only option that survives an air-gap requirement, and it keeps the existing OAuth + GitHub App model working unchanged |
| B | **Who operates the install?** | We host single-tenant **/** the customer runs it in their own datacenter | **Customer-operated.** That is what "on-prem" is being asked for, and it forces the integrate-don't-install rule below |

### The integrate-don't-install rule

A customer big enough to want on-prem already runs Vault, Artifactory, Postgres,
a Kubernetes platform team, and a log sink. An install that ships its own copy of
each is what loses the deal — not because the tools are wrong, but because their
platform team will not adopt seven new operators to run one vendor's app.

So every slot below is classified:

- **BYO** — the customer almost certainly has this. We integrate; the chart takes
  an endpoint and a credential. We must work with theirs, not ours.
- **Ship** — we ship it in the chart because the app does not work without it and
  no customer has a pre-existing equivalent.
- **Optional** — we ship a working default that a customer can switch off and
  point at their own.

That classification is the actual deliverable of this document. The tool names
are the easy part.

---

## 1. Tool inventory

### 1.1 Control plane — the AlphaCI application itself

| Slot | Tool | Class | Replaces today | Why this one |
|------|------|-------|----------------|--------------|
| Container orchestration | Kubernetes — **RKE2** or **K3s**, or the customer's existing cluster / OpenShift | BYO | Render | `FUTURE_STATE` §7 needs 1 container (bundled) or 7 (split) from one image digest. RKE2 is the common CIS/FIPS-hardened on-prem distro; K3s for a small single-node appliance. The chart must be distro-agnostic |
| Packaging | **Helm** chart, one per release | Ship | `render.yaml` | `deploy/tenants/<customer>/release.yaml` (§7) becomes a Helm values file. Chart version + image digest = a release |
| Delivery | **Argo CD** (or Flux) | Optional | Render auto-deploy | Pull-based: the cluster reaches out, nothing inbound from us. This is the property that makes air-gapped and firewalled installs work at all |
| Database | **CloudNativePG** operator, or the customer's managed Postgres | BYO | Supabase | Answers open decision 5: **plain Postgres**. Nothing in the target design needs Supabase — sessions are `express-session` on `public.session`, auth is GitHub OAuth, and `libs/db` already speaks a plain `SUPABASE_DB_URL`. CNPG gives PITR, replicas and barman backups to S3 |
| Connection pooling | **PgBouncer** (CNPG ships it), or none | Optional | Supavisor | The `EMAXCONNSESSION` note in `database.service.ts` was a Supavisor `pool_size: 15` artifact. On a dedicated Postgres the bundled-mode budget (§3) fits without a pooler; keep the sizing env vars anyway |
| Secrets store | **HashiCorp Vault** (or **OpenBao** where BSL licensing is a blocker) | BYO | GitHub Secrets + `.env` | Three distinct jobs — see §4. Every enterprise on-prem shop has one already |
| Secret delivery to pods | **External Secrets Operator**, or **Vault Agent Injector** | Optional | Render env vars | ESO if the customer wants one operator for many backends; Agent Injector if they are Vault-native. Support both; the chart reads plain env either way |
| Container registry | **Harbor** — or their Artifactory / Nexus | BYO | GHCR | Must hold our image digests, the Helm chart as OCI, and act as a **proxy cache** for upstream images. Harbor also gives Trivy scanning and cosign/Notation verification on the same box |
| Language package mirror | **Nexus** / **Artifactory** / **Verdaccio** | BYO | npmjs.org direct | The commonly forgotten one. `npm ci` in a runner pod has no internet in an air-gap. `.npmrc` points at the mirror |
| Ingress | **ingress-nginx** or Traefik | BYO | Render edge | Internal-only. `edge-gateway` (FUTURE_STATE §2) sits behind it in split mode; in bundled mode it fronts the single pod |
| TLS | **cert-manager** + internal CA issuer (**step-ca**, ADCS, or Vault PKI) | Ship (cert-manager) / BYO (CA) | Render-managed certs | Let's Encrypt cannot reach an internal hostname. Vault PKI is the neat answer when Vault is already there |
| Object storage | **MinIO** | Ship | nothing today | Non-optional in practice: GHES Actions **requires** S3-compatible blob storage for artifacts and cache, and CNPG/Velero backups want the same. One MinIO serves all three |
| Metrics | **Prometheus** + **Grafana** (kube-prometheus-stack) | Optional | Render dashboards | Expose `/metrics` per context; the per-context health endpoints from §7 step 5 become probes |
| Logs | **Loki**, or ship to their Splunk/Elastic via **Vector** / Fluent Bit | Optional | Render logs | Vector is the honest default — most customers want logs in their existing sink, not a second Grafana |
| Traces | **OpenTelemetry Collector** → **Tempo** / Jaeger | Optional | none | The `X-Correlation-ID` middleware already in `common/` becomes real distributed tracing the moment split mode turns on. Cheap win, high value in split mode |
| Alerting | **Alertmanager** → their PagerDuty / Teams | Optional | none | |
| Backup | **Velero** (cluster + PVC) + CNPG `barman-cloud` to MinIO | Optional | Supabase backups | Enterprise contracts ask for RPO/RTO in writing. Define it here or it gets defined for you during a negotiation |
| Admission policy | **Kyverno** (or Gatekeeper) | BYO | none | Enforces digest-pinned images, non-root, no `:latest`. Our Dockerfile already runs as a non-root `nestjs` user, so we pass their policy out of the box — say so in the security questionnaire |
| SSO (platform login) | **GitHub OAuth against GHES** — *not* Keycloak | Ship | GitHub OAuth (github.com) | Important: on GHES you register the OAuth App and the GitHub App on the appliance itself, so `GITHUB_CLIENT_ID` / `GITHUB_CALLBACK_URL` / `SessionAuthGuard` port over **unchanged**. Add **Keycloak/Dex** only for a customer who insists on SAML-to-AD login independent of GHES — that is the "Identity: Large" item in modular §12.3, and it stays out of scope |
| Email | **SMTP relay** (their Exchange / Postfix) | BYO | SaaS email API | `platform-ops` sends through a host, port and credential, nothing more |
| Async transport | **Postgres outbox + in-process relay** — *no broker* | Ship | `KAFKA_BROKERS` | `FUTURE_STATE` §6 already made this call. Delete Kafka from the on-prem env surface; it is one less thing on the customer's runbook. If a real broker is ever needed, **NATS** before Kafka |
| Licensing | **Signed offline license file** (JWT, our offline key) | Ship | PayMongo | Answers open decision 4: an enterprise install has no payment gateway. `billing` reduces to entitlements, `usage` quotas become advisory. No phone-home |

### 1.2 CI plane — GitHub Actions, on-prem

| Slot | Tool | Class | Notes |
|------|------|-------|-------|
| Forge + Actions control | **GitHub Enterprise Server** | BYO | Fork A. Actions on GHES needs its blob storage configured (MinIO) before any of this works |
| Runners | **Actions Runner Controller (ARC)** — `gha-runner-scale-set` Helm charts | Ship | Official GitHub project. Ephemeral runner pods, one per job, autoscaled by a listener that polls GHES. Own namespace, own service account |
| Runner image | Custom image on our base | Ship | Pre-baked Node 22, the CLI tools our generated workflows call, and the internal CA bundle. Pre-baking is what keeps an air-gapped `npm ci` fast |
| In-pipeline image build | **BuildKit** (rootless daemon) or **Kaniko** | Ship | Prefer either over privileged docker-in-docker — Kyverno-friendly, and it clears the security review. A shared BuildKit deployment also gives a warm build cache |
| Action mirroring | **GitHub Connect** (if there is egress) or **`actions-sync`** (if not) | Ship (tooling) | Our generated workflows reference `actions/checkout@v4` and friends. On an air-gapped GHES those resolve to nothing unless mirrored into an internal org. **Pin by commit SHA, not tag**, once mirrored |
| Actions cache | GHES cache backed by **MinIO** | Ship | Same MinIO as artifacts |
| Code quality | **SonarQube** (self-hosted) | BYO | Replaces SonarCloud in `sonar-project.properties`. Needs its own Postgres + PVC — check whether they already run one |
| Vulnerability scan | **Trivy** in-pipeline + Harbor scan | Ship | `.trivyignore` already exists; the vulnerability DB needs an offline mirror in an air-gap |
| Perf gate | **k6** (OSS binary in the runner) | Ship | Unchanged from today |
| SBOM / compliance | **Syft** → **Dependency-Track** | Optional | Only when a customer asks. They will |
| CI → secrets | **GitHub OIDC → Vault JWT auth** | Ship | The important one — see §4.3 |

**Appliance version is a hard prerequisite.** The `gha-runner-scale-set` charts
need a reasonably current GHES (3.9+ at time of writing) and Actions OIDC needs
the appliance's issuer reachable from Vault. Confirm the customer's actual GHES
version and upgrade cadence before quoting Phase 1 — a customer three minor
versions behind turns this into their upgrade project first, not ours.

### 1.3 On-prem deployment provider — the new plugin

A new provider folder under `src/modules/deployments/providers/` per
`modular-architecture-deployments.md` §3, and the first provider to use the
extension points that document deliberately relaxed in §12.

| Contract field | Value | Consequence |
|----------------|-------|-------------|
| `connectivity` | `direct` for **status**, indirect for **execution** | The platform runs inside the same cluster, so it can read live state from the Kubernetes or Argo CD API — but it never performs the deploy. That is the runner's job |
| `credentialCustody` | `external` | No cluster kubeconfig is ever stored in our database. The single biggest security-review win available here |
| `enumerable` | `true` | Namespaces and workloads are listable through the API the platform already has read access to |
| Creation | `status: 'provisioning'`, then async | Exactly the shape §6 of that document specified |
| Status freshness | `source: 'live'`, `observedAt` from the API read | Better than the Render/Vercel path, not worse |

**Recommended deploy mechanism: GitOps, not `kubectl` from CI.**

The generated workflow builds and pushes an image, then writes the digest to a
per-project GitOps repository on GHES. Argo CD reconciles. The runner therefore
needs a Harbor push credential and a repo write token — never cluster
credentials. Add **Argo Rollouts** only if a customer asks for canary.

The direct alternative (`helm upgrade` from the runner using a namespace-scoped
ServiceAccount token) is simpler to ship and worth keeping as a fallback mode,
but it puts a cluster credential in Actions secrets and gives up the audit trail
Argo CD provides for free.

### 1.4 Codebase gaps this SKU must close (measured, not estimated)

CI/CD stays GitHub Actions — same engine, same reusable-workflow orchestrator
pattern, same `permissions` ceiling and `secrets: inherit` shape as
`.github/workflows/be-pipeline-caller.yml` uses today. All of that is portable to
GHES unchanged. What is *not* portable is every place the generator assumes
github.com and GitHub-hosted runners:

| # | Gap | Location | Change |
|:-:|-----|----------|--------|
| 1 | **`runs-on: ubuntu-latest` hardcoded 6×** | `staged-workflow.builder.ts:504, 559, 594, 638, 677, 1067` | Emit a configurable label matching the ARC scale-set name (`[self-hosted, alphaci-linux]`). There is no `ubuntu-latest` on-prem — every generated pipeline queues forever until this changes. Cheapest fix in the list, hardest failure to diagnose |
| 2 | **Central workflow org/repo is a constant, not config** | `staged-workflow.builder.ts:28` — `'cicd-external-project/cicd-workflow/.github/workflows'` | `CENTRAL_WORKFLOW_REF` only controls the *git ref* (`v1` / `internal-v1`), so the existing knob **cannot** repoint at a mirrored org on a customer appliance. Needs `CENTRAL_WORKFLOW_OWNER` / `CENTRAL_WORKFLOW_REPO` alongside it |
| 3 | **44 hardcoded `api.github.com` calls across 8 files** | `auth.service.ts`, `catalog.service.ts`, `github.controller.ts`, `github.service.ts`, `config-broker/providers/github-secrets.provider.ts`, `github-sync/providers/github-team-access.live.ts`, `projects.service.ts`, `staged-workflow.builder.ts` | One `GITHUB_API_BASE_URL` (GHES is `https://<host>/api/v3`, not `/`). The 16 further non-API `github.com` references are clone and web URLs and need a second `GITHUB_WEB_BASE_URL`. This is the largest single item in the whole on-prem effort |
| 4 | **Marketplace actions pinned by tag** | `actions/checkout@v6` at `:506, :646, :685`; `actions/setup-node@v6` at `:652, :691` | Must exist on the appliance via `actions-sync`, then be **SHA-pinned**. See the Phase 1 warning in §7 |
| 5 | **Deploy jobs are Render/Vercel reusable workflows** | `:807` `vercel-deploy.yml`, `:868` `render-deploy.yml` | Replaced by an `onprem-k8s` workflow emitter living in `providers/onprem-k8s/` per modular §3 — a GitOps commit job, not a deploy-hook call |
| 6 | **`sonarcloud-scan.yml` and `docker-build.yml` → GHCR** | `:293`, `:844` | Repoint at SonarQube and Harbor. Both are reusable workflows in the central repo, so this is a change in the mirror, not in this codebase |
| 7 | **CI credentials via the Actions secrets API** | `github.service.ts:1398, 2059, 2094` | Those endpoints exist identically on GHES, so this keeps working as-is. Add the Vault OIDC role path from §4.3 as the preferred mode, keep this as fallback |

Gaps 1 and 2 are hours of work each. Gap 3 is the one to scope honestly before
committing to a date, and it is worth doing behind a single client wrapper rather
than 44 find-and-replaces.

### 1.5 If Fork A resolves to github.com instead

Keeping github.com as the Actions control plane with only the runners on-prem
removes gaps 2, 3 and 4 entirely — no mirroring, no base-URL work, marketplace
actions resolve normally. It costs three things instead:

| Consequence | Detail |
|-------------|--------|
| Egress is mandatory | The ARC listener, runner pods and the platform all need outbound HTTPS to github.com through their proxy. An air-gap requirement kills this option outright |
| Source code leaves the building | Repos live on github.com. For most customers who ask for on-prem, that is the exact thing they were trying to prevent — worth confirming before designing around it |
| Inbound webhooks | github.com must reach the `pipelines` webhook route, so either an inbound ingress rule from GitHub's ranges, or drop webhooks and lean entirely on the runner-initiated `POST /ci/report` channel |

The runner architecture — ARC, ephemeral pods, BuildKit, the OIDC-to-Vault
exchange, the GitOps deploy — is **identical either way**. That is why Phase 1
below is worth starting before Fork A is settled.

---

## 2. Topology

```text
════════════════════ customer network / air-gap boundary ════════════════════

  ┌─────────────────────────┐          ┌──────────────────────────────┐
  │ GHES appliance          │          │ Vault              (BYO)     │
  │  repos, Actions control │          │ Harbor/Artifactory (BYO)     │
  │  OAuth App + GitHub App │          │ SonarQube          (BYO)     │
  └───────────┬─────────────┘          │ SMTP relay         (BYO)     │
              │                        │ AD / LDAP          (BYO)     │
              │                        └──────────────┬───────────────┘
              │                                       │
  ┌───────────┴───────────────── Kubernetes ──────────┴───────────────┐
  │                                                                   │
  │  ns: alphaci-runners            ns: alphaci                       │
  │  ┌──────────────────────┐       ┌──────────────────────────────┐  │
  │  │ ARC controller       │       │ ingress-nginx + cert-manager  │ │
  │  │ listener (polls GHES)│       │            │                  │ │
  │  │ ephemeral runner pods│       │  ┌─────────▼───────────────┐   │ │
  │  │  ├ build (BuildKit)  │       │  │ edge-gateway            │   │ │
  │  │  ├ test / sonar / k6 │       │  │  (split mode only)      │   │ │
  │  │  └ deploy = GitOps   │       │  └─────────┬───────────────┘   │ │
  │  │      commit          │       │   identity-access, projects,   │ │
  │  └──────────┬───────────┘       │   pipelines, runtime,          │ │
  │             │                   │   billing, platform-ops        │ │
  │             │  POST /ci/report  │   (1 pod bundled / 7 split)    │ │
  │             └──────────────────►│            │                   │ │
  │                                 └────────────┼───────────────────┘ │
  │  ns: argocd            ns: data              │                     │
  │  ┌──────────────┐      ┌─────────────────────▼─────────────────┐   │
  │  │ Argo CD      │      │ Postgres (CNPG) — one DB per install  │   │
  │  │  reconciles  │◄─────┤ MinIO — Actions artifacts + cache,    │   │
  │  │  app + user  │      │         CNPG / Velero backups         │   │
  │  │  workloads   │      └───────────────────────────────────────┘   │
  │  └──────────────┘                                                  │
  │  ns: observability — Prometheus, Grafana, Loki/Vector, OTel, Tempo  │
  └────────────────────────────────────────────────────────────────────┘
```

---

## 3. Connection map

Every edge, its protocol, its auth, and — the part that matters for a firewall
review — its direction.

### 3.1 Platform → outward

| From | To | Protocol | Auth | Purpose |
|------|-----|----------|------|---------|
| any context | Postgres | TCP 5432, TLS | **Vault-issued dynamic credential** for `CTX_DB_ROLE` | All data access, one role per context (`FUTURE_STATE` §5) |
| any context | Vault | HTTPS 8200 | Kubernetes ServiceAccount JWT → Vault k8s auth | Config secrets, transit encrypt/decrypt |
| `pipelines`, `projects` | GHES | HTTPS 443 | GitHub App installation JWT → installation token | Repo creation, branch setup, workflow commit, secret install |
| `runtime` | Argo CD API / K8s API | HTTPS 443 | Argo API token / scoped ServiceAccount, **read-only** | Live deployment status for the on-prem provider |
| `platform-ops` | SMTP relay | TCP 587, STARTTLS | SMTP credential from Vault | Notifications |
| all | OTel Collector | gRPC 4317 | none (in-cluster; mTLS optional) | Traces keyed by `X-Correlation-ID` |
| context → context (split only) | sibling `http/internal/` | HTTP in-cluster | `x-internal-token`, JWT signed with `INTERNAL_JWT_SECRET` from Vault | Session lookup, account directory |
| context → context (bundled) | — | in-process | — | Same ports, in-process adapter. No network edge at all |

### 3.2 Inward → platform

| From | To | Protocol | Auth | Purpose |
|------|-----|----------|------|---------|
| GHES | `pipelines` webhook route | HTTPS 443 via ingress | HMAC webhook secret | Push, PR, `workflow_run`, App installation events |
| runner pod | `pipelines` `POST /ci/validate`, `POST /ci/report` | HTTPS via ingress | project-scoped `aci_` token, injected as an Actions secret | Pipeline results, deploy outcome. **This channel already exists** — it is the mechanism modular §12 relies on |
| browser | ingress → `edge-gateway` | HTTPS 443 | session cookie signed with `SESSION_SECRET` | The product UI |
| browser | GHES | HTTPS 443 | GHES OAuth redirect | Login (`GITHUB_CALLBACK_URL` now points at the appliance) |

### 3.3 CI plane edges

| From | To | Protocol | Auth | Purpose |
|------|-----|----------|------|---------|
| ARC listener | GHES | HTTPS 443, **outbound only** | GitHub App for ARC | Poll for queued jobs, register ephemeral runners. No inbound port to the cluster — this is why ARC beats static VM runners on a locked-down network |
| runner pod | Vault | HTTPS 8200 | **GHES Actions OIDC token** → Vault JWT auth | Exchange the workflow identity for a short-lived deploy credential (§4.3) |
| runner pod | Harbor | HTTPS 443 | Vault-issued robot account, or OIDC | Pull base images, push built images |
| runner pod | npm mirror | HTTPS 443 | read token | `npm ci` |
| runner pod | SonarQube | HTTPS 443 | token from Vault | Quality gate |
| runner pod | GHES (GitOps repo) | HTTPS 443 | App installation token, write-scoped to that repo | Commit the new image digest |
| Argo CD | GHES (GitOps repo) | HTTPS 443, outbound | deploy key | Reconcile desired state |
| Argo CD | Harbor | HTTPS 443 | robot pull account | Resolve and pull digests |
| GHES | MinIO | HTTPS 9000 | S3 access key | Actions artifacts and cache |

### 3.4 Delivery of our own releases

| Path | Mechanism |
|------|-----------|
| Connected install | We publish image + Helm chart (OCI) to our registry. Their Harbor **replicates or proxy-caches** it. Argo CD tracks the chart at a pinned digest |
| Air-gapped install | We produce an offline bundle — images, chart, migrations, Trivy DB — with **`oras`/`skopeo`**, or a purpose-built packager (**Zarf** / **Hauler**). The customer imports it into Harbor over sneakernet, then Argo CD reconciles from the internal copy |
| Build vs buy | **Replicated (KOTS / Embedded Cluster)** does air-gap packaging, license enforcement, update channels and support bundles as a product. Worth costing against the engineering time the two rows above represent — this is a whole delivery surface, not a script |
| Diagnostics | **`troubleshoot.sh` support bundle** — one command that collects logs, versions, health, and the migration high-water mark. Without it, every support ticket is a screen-share |

---

## 4. Secrets architecture

Vault does three unrelated jobs here. Conflating them is the usual mistake.

### 4.1 Platform configuration secrets

`SESSION_SECRET`, `INTERNAL_JWT_SECRET`, the GitHub App private key, the SMTP
credential, the Argo API token. Stored under `kv/alphaci/<install>/`, delivered
to pods by ESO or the Agent Injector. `env.validation.ts` already fails fast on
missing values in production, which is the right behavior for a customer-run
install — a misconfigured pod must not start and pretend to work.

### 4.2 Tenant runtime encryption — replace the local key

`ENV_PROVISIONING_ENCRYPTION_KEY` is a symmetric key held in application env
today, used to encrypt customer provider credentials at rest. On-prem, move it to
**Vault's transit engine**: the key never leaves Vault, the app calls
encrypt/decrypt, and rotation plus rewrap become Vault operations instead of a
migration script. This also directly relieves the risk called out in modular §13
about the credential re-encryption backfill touching live secrets.

### 4.3 CI credentials — OIDC, not stored secrets

Today `installCiSecrets` writes provider tokens into GitHub Actions secrets. That
works and should keep working as a fallback. But the on-prem-native path is
better, and worth building for this provider first:

```text
runner pod                GHES                       Vault
    │  request OIDC token  │                           │
    ├─────────────────────►│                           │
    │◄── JWT: repo, ref, ──┤                           │
    │    workflow, env     │                           │
    │                                                  │
    ├── exchange JWT (Vault JWT auth, role bound to ───►│
    │    repo + ref + environment claims)               │
    │◄── short-lived Harbor robot + GitOps token ───────┤
```

What this buys: no long-lived deploy credential exists anywhere, the Vault role
binds to a specific repo *and* ref *and* environment, revocation is instant, and
every issuance lands in Vault's audit log. On a security questionnaire that
answer is worth more than any other line in this document.

The platform's job changes from "install a token" to "ensure a Vault role
exists" — same `installCiSecrets` seam, different implementation.

---

## 5. What gets deleted

The on-prem SKU is defined as much by removals as additions.

| Today | On-prem | Note |
|-------|---------|------|
| Supabase (`SUPABASE_URL`, anon key, service-role key) | plain Postgres via `SUPABASE_DB_URL` only | Open decision 5 answered. RLS stays as defense-in-depth per §5 |
| Render (`FLOWCI_RENDER_*`, 8 vars) | on-prem K8s provider | The provider folder stays in the codebase; it is just never enabled in this SKU |
| Vercel (`FLOWCI_VERCEL_*`) | same | |
| PayMongo (`PAYMONGO_*`, `PRO_MONTHLY_PRICE_PHP`, `PAYMENT_*`) | signed license file | Open decision 4 answered: entitlements only |
| SonarCloud | SonarQube | |
| GHCR | Harbor / Artifactory | |
| `KAFKA_BROKERS`, `KAFKA_SSL` | nothing — Postgres outbox | `FUTURE_STATE` §6 |
| `GITHUB_ENFORCED_ORG` default `Alpha-Explora` | the install's own org on their GHES | Open decision 3 answered: **each install registers its own GitHub App** on its own appliance. There is no shared central App, and no cross-install webhook routing to design |
| Central workflows resolved from `cicd-external-project` | internal mirror in the customer's own GHES org | Mirrored by the same `actions-sync` path as marketplace actions. Note `CENTRAL_WORKFLOW_REF` is *not* sufficient — it only moves the ref, not the org (gap 2 in §1.4) |
| `K6_CLOUD_TOKEN` | local k6 binary only | No k6 Cloud in an air-gap; the OSS runner covers the gate |

---

## 6. Two install profiles

Mirrors the Standard/Scale tiering in `FUTURE_STATE` §7 so there is one tiering
concept, not two.

| | **Standard** (default) | **Scale** |
|---|---|---|
| App mode | `DEPLOY_MODE=bundled`, 1 pod | `split`, 7 pods incl. gateway |
| Cluster | K3s single node, or a namespace on theirs | Their multi-node cluster |
| Postgres | CNPG single instance, or their Postgres | Their HA Postgres |
| Delivery | `helm upgrade` from a runbook | Argo CD GitOps |
| Runners | one ARC scale set, 2–5 replicas | multiple scale sets by label, autoscaled |
| Secrets | ESO → their Vault | Vault Agent Injector + OIDC everywhere |
| Observability | stdout → their sink via Vector | full Prometheus / Loki / Tempo |
| Registry | their existing one | Harbor with replication + signing |
| Must-ship count | **~4** (chart, ARC, MinIO, cert-manager) | ~12 |

Standard is the one to build first. It is the honest answer to "what does it take
to run this in our datacenter" and it is roughly a day of installation, not a
quarter. Scale is a migration of the same chart, exactly as bundled→split is a
single environment variable.

---

## 7. Sequencing

| Phase | Work | Exit |
|:-----:|------|------|
| 0 | Cut the Supabase dependency to a plain `DATABASE_URL`; Helm chart for bundled mode; Vault kv + transit for §4.1/§4.2 | The current single deployable runs on a K3s box against plain Postgres |
| 1 | ARC + runner image + `actions-sync` mirror; gaps 1–4 of §1.4 (runner label, central-workflow owner/repo config, `GITHUB_API_BASE_URL`, SHA-pinned mirrored actions) | A generated workflow runs green end to end on a self-hosted runner against GHES |
| 2 | `providers/onprem-k8s/` under the modular-architecture contract; GitOps deploy job; status via Argo CD API | A project provisions and deploys inside the customer network |
| 3 | License file replaces billing; support bundle; air-gap bundle via `oras` / Zarf | Shippable Standard profile |
| 4 | Observability stack; Velero + CNPG backup policy with a written RPO/RTO; Kyverno-clean posture | Passes an enterprise security review |
| 5 | Split mode + Argo CD + Harbor replication | Scale profile |

Phase 1 is the risky one, and not for an obvious reason: **an air-gapped GHES
resolves no marketplace action**. Every generated workflow breaks at
`actions/checkout` until the mirror exists. Prove that on a real appliance before
promising a date.

---

## 8. Open questions

| # | Question | Gates |
|:-:|----------|-------|
| 1 | GHES, or github.com with self-hosted runners only? A customer already on EMU may not buy a second appliance | Fork A — everything |
| 2 | Air-gap: hard requirement, or "restricted egress through a proxy"? Very different projects; customers use the words interchangeably | Phase 3 |
| 3 | Do we require a cluster, or must a docker-compose profile exist? Some on-prem buyers have no Kubernetes at all | Phase 0 |
| 4 | Support model — can we get logs and a support bundle out of a customer network, or is every incident a screen-share? | Phase 3 |
| 5 | Version skew across installs (open decision 6 in `FUTURE_STATE`) is worse when the customer controls the upgrade button. Forced-upgrade window in the contract, or a supported-version matrix? | Phase 3 |
| 6 | Build vs buy on Replicated for packaging, licensing and updates | Phase 3 |
