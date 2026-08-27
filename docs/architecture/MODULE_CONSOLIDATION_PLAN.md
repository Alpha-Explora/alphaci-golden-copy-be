# Module Consolidation Plan — Current State vs Future State

**Status:** remediation trunk implementation complete; current verification and
evidence are recorded in `REMEDIATION_EVIDENCE.md`. The six-context
consolidation and review-closure slices are implemented on
`codex/architecture-remediation-trunk`. Microservice extraction is future-only
and outside this plan. A pre-consolidation route baseline was recovered from
`b175938`; a pre-consolidation contract baseline was not present in that source
commit and remains explicitly unavailable.
**Date:** 2026-08-28
**Scope:** `src/modules/**` topology plus behavior-preserving boundary
remediation. No intentional endpoint, response, schema-value, provider
behavior, or deployment contract change is proposed here; compatibility
adapters and evidence gates are documented where implementation needed to
close a review finding.

## 1. Why consolidate

Two goals, in priority order:

1. **Minimise module count.** 17 top-level modules is more boundaries than the
   product has real ownership lines. Every extra boundary is another
   `index.ts` to curate, another Nest module to wire, another place where a
   feature lands in the wrong folder.
2. **Preserve a safe future service-extraction option, without doing it now.**
   A service boundary is only extractable if the seam is already (a) a small
   number of coarse contracts, (b) serialisable, and (c) free of import cycles.
   Those three properties are worth having in a monolith regardless. This plan
   buys them without buying gateways, internal JWT, or six connection pools.

Explicit non-goal: shipping microservices. `docs/architecture/FUTURE_STATE.md`
already records that the split-services topology was **rejected**. This plan
does not reopen that. It leaves the door unlocked; it does not walk through it.

## 2. Baseline state (measured 2026-08-26, HEAD `b175938`)

The inventory below is the pre-consolidation baseline retained for comparison.
The authoritative implemented state is in §2.5 and in
`docs/superpowers/plans/2026-08-26-module-consolidation-six-contexts.md`.

### 2.1 Module inventory

| Module | Files | Lines | Internal layering today |
|---|---:|---:|---|
| `deployments` | 97 | 16,188 | `application` `core` `domain` `dto` `infrastructure` `presentation` |
| `projects` | 54 | 15,437 | `application` `dto` (+ 20 flat root files) |
| `hierarchy` | 56 | 7,146 | 8 feature folders, no layers |
| `github` | 16 | 5,247 | `dto` only, flat |
| `auth` | 11 | 2,928 | `infra` |
| `workflows` | 12 | 2,578 | `dto` `infra` |
| `ci` | 17 | 1,992 | `dto` `infra` |
| `admin` | 14 | 1,296 | `dto` `guards` |
| `workspaces` | 10 | 1,220 | flat |
| `catalog` | 7 | 1,210 | `dto` |
| `subscription` | 10 | 958 | `dto` `infra` |
| `existing-repos` | 8 | 908 | `dto` |
| `usage` | 7 | 504 | flat |
| `capabilities` | 4 | 378 | flat |
| `notifications` | 7 | 370 | `api` `application` `infra` |
| `audit` | 6 | 342 | flat |
| `feedback` | 7 | 279 | `dto` |

17 modules, 343 files, ~58,300 lines. (Earlier notes say "19 modules"; the
`database` and `persistence` modules have since been folded into `kernel/`.)

### 2.5 Implemented current tree (2026-08-28)

```text
src/
├── kernel/                         # shared runtime, auth, DB, HTTP, events
├── health/                         # application health entry point
└── modules/
    ├── identity-access/            # auth + admin + capabilities + workspaces + hierarchy
    │   ├── identity-access.module.ts
    │   ├── auth/
    │   ├── admin/
    │   ├── capabilities/
    │   ├── workspaces/
    │   └── hierarchy/
    ├── projects/                   # projects + catalog + workflows + existing-repos
    │   ├── projects.module.ts
    │   ├── api/
    │   ├── application/
    │   │   ├── catalog/
    │   │   ├── dashboard/
    │   │   ├── drift/
    │   │   ├── existing-repos/
    │   │   ├── lifecycle/
    │   │   └── workflows/
    │   │       └── infrastructure/
    │   └── contracts/
    ├── pipelines/                  # github + ci
    │   ├── pipelines.module.ts
    │   ├── github/
    │   └── ci/
    ├── runtime/                    # deployments, provider registry, provider adapters
    │   ├── runtime.module.ts
    │   ├── api/
    │   ├── application/
    │   ├── core/
    │   ├── domain/
    │   └── infrastructure/
    ├── billing/                    # subscription + usage
    │   ├── billing.module.ts
    │   ├── subscription/
    │   └── usage/
    └── platform-ops/               # notifications + feedback + audit
        ├── platform-ops.module.ts
        ├── notifications/
        ├── feedback/
        └── audit/
```

The migration tree now follows the same six-owner shape:
`supabase/migrations/{identity-access,projects,pipelines,runtime,billing,platform-ops}`.
`scripts/check-schema-ownership.cjs` enforces the published map in
`docs/architecture/SCHEMA_OWNERSHIP.md`; `db:apply:all --dry-run` preserves
the old global timestamp replay order.

Three observations drive the grouping:

- **Size is bimodal.** Two modules hold 54% of the code; seven modules hold
  under 1,000 lines each. The small ones are not bounded contexts, they are
  files that were given a folder.
- **Layering is inconsistent.** Four different internal conventions coexist
  (`presentation/` vs `api/`, `infrastructure/` vs `infra/`, layered vs flat).
  `src/modules/README.md` documents `api|domain|infra`; almost nothing follows
  it.
- **`deployments` already has the target shape.** It is the reference
  implementation for everything below.

### 2.2 Coupling today

Static import scan of `src/modules/**` (non-spec files, relative and aliased
specifiers resolved):

- **40 distinct module-to-module edges**
- **135 cross-module import statements**

Heaviest edges:

| Count | Edge |
|---:|---|
| 14 | `projects -> deployments` |
| 12 | `projects -> workflows` |
| 9 | `hierarchy -> audit` |
| 9 | `projects -> github` |
| 5 | `deployments -> workspaces` |
| 5 | `hierarchy -> github` |
| 5 | `projects -> audit` |
| 5 | `projects -> notifications` |

`projects` alone participates in 12 outbound edges. Any change to it touches a
third of the module graph.

### 2.3 What is already in place

| Asset | State |
|---|---|
| `kernel/{db,events,auth}` extracted | done |
| `.dependency-cruiser.cjs` boundary gates | live in CI, **0 known violations** |
| `no-deep-module-imports`, `no-cross-module-deep-imports`, `no-circular` | enforced |
| `deployments` hexagonal layering + provider isolation rule | enforced |
| `docs/architecture/DDD_CONTEXT_MAP.md` | published |

The boundary machinery exists and is green. That is what makes this
consolidation a *move* exercise rather than a *repair* exercise.

### 2.4 Baseline full tree (historical)

```text
src/
├── common/
│   ├── config/
│   │   ├── env.validation.ts
│   │   └── security.config.ts
│   ├── filters/
│   │   └── all-exceptions.filter.ts
│   ├── guards/
│   │   ├── dev-only.guard.ts
│   │   ├── session-auth.guard.ts
│   │   └── subscription.guard.ts
│   ├── interfaces/
│   │   └── session-user.interface.ts
│   └── middleware/
│       └── correlation-id.middleware.ts
├── config/
│   └── app.config.ts
├── database/
│   └── seeds/
│       └── dummy-users.json
├── health/
│   ├── health.controller.ts
│   ├── health.module.ts
│   └── health.service.ts
├── kernel/
│   ├── auth/
│   │   └── session-user-lookup.contract.ts
│   ├── db/
│   │   ├── supabase/
│   │   │   ├── supabase.module.ts
│   │   │   └── supabase.service.ts
│   │   ├── database.module.ts
│   │   ├── database.service.ts
│   │   └── postgres-ssl.config.ts
│   ├── events/
│   │   ├── events.module.ts
│   │   └── outbox.repository.ts
│   └── README.md
├── modules/
│   ├── admin/
│   │   ├── dto/
│   │   │   ├── grant-role.dto.ts
│   │   │   ├── list-users-query.dto.ts
│   │   │   └── set-app-role.dto.ts
│   │   ├── guards/
│   │   │   ├── platform-admin.guard.ts
│   │   │   └── super-admin.guard.ts
│   │   ├── admin-user.view.ts
│   │   ├── admin.controller.ts
│   │   ├── admin.module.ts
│   │   ├── admin.repository.ts
│   │   ├── admin.service.ts
│   │   ├── index.ts
│   │   ├── platform-admin-access.service.ts
│   │   └── platform-admins.repository.ts
│   ├── audit/
│   │   ├── audit-events.repository.ts
│   │   ├── audit-events.service.ts
│   │   ├── audit.module.ts
│   │   └── index.ts
│   ├── auth/
│   │   ├── infra/
│   │   │   ├── oauth-state.repository.ts
│   │   │   └── users.repository.ts
│   │   ├── auth-identity.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts
│   │   └── index.ts
│   ├── capabilities/
│   │   ├── capabilities.controller.ts
│   │   ├── capabilities.module.ts
│   │   └── index.ts
│   ├── catalog/
│   │   ├── dto/
│   │   │   └── list-catalog-query.dto.ts
│   │   ├── catalog.controller.ts
│   │   ├── catalog.module.ts
│   │   ├── catalog.service.ts
│   │   └── index.ts
│   ├── ci/
│   │   ├── dto/
│   │   │   ├── ci-report-body.dto.ts
│   │   │   ├── get-runs-query.dto.ts
│   │   │   └── validate-ci-run.dto.ts
│   │   ├── infra/
│   │   │   └── ci-tokens.repository.ts
│   │   ├── ci-reports.service.ts
│   │   ├── ci-run-reports.repository.ts
│   │   ├── ci.contracts.ts
│   │   ├── ci.controller.ts
│   │   ├── ci.module.ts
│   │   ├── ci.service.ts
│   │   ├── index.ts
│   │   └── translate-results.ts
│   ├── deployments/
│   │   ├── application/
│   │   │   ├── custom-domains.service.ts
│   │   │   ├── deployment-targets.service.ts
│   │   │   ├── encryption.service.ts
│   │   │   ├── env-vars.service.ts
│   │   │   ├── local-deployment-history.provider.ts
│   │   │   ├── project-deployment-provisioning.service.ts
│   │   │   ├── project-deployments.service.ts
│   │   │   ├── project-deployments.types.ts
│   │   │   ├── project-drift.service.ts
│   │   │   ├── project-drift.types.ts
│   │   │   ├── project-sync-findings.repository.ts
│   │   │   ├── provider-connections.service.ts
│   │   │   ├── render-ci-secrets.service.ts
│   │   │   ├── render-cost-policy.service.ts
│   │   │   └── vercel-ci-secrets.service.ts
│   │   ├── core/
│   │   │   ├── deployment-provider-runtime.contract.ts
│   │   │   ├── deployment-provider.contract.ts
│   │   │   ├── deployment-provider.registry.ts
│   │   │   ├── deployment-providers.controller.ts
│   │   │   ├── deployment-provisioning.contract.ts
│   │   │   ├── deployments-core.module.ts
│   │   │   ├── deployments.types.ts
│   │   │   └── provider-public-url.ts
│   │   ├── domain/
│   │   │   ├── deployment-strategy.resolver.ts
│   │   │   └── deployment-target.policy.ts
│   │   ├── dto/
│   │   │   ├── create-deployment-target.dto.ts
│   │   │   ├── create-provider-connection.dto.ts
│   │   │   ├── detach-deployment-target.dto.ts
│   │   │   └── provision-env-vars.dto.ts
│   │   ├── infrastructure/
│   │   │   ├── providers/
│   │   │   │   ├── core/
│   │   │   │   │   ├── fetch-with-retry.ts
│   │   │   │   │   ├── provider-client.registry.ts
│   │   │   │   │   ├── provider-contract.suite.ts
│   │   │   │   │   └── runtime-env-provider.client.ts
│   │   │   │   ├── gcp/
│   │   │   │   │   ├── infrastructure/
│   │   │   │   │   │   └── google-cloud-runtime.adapter.ts
│   │   │   │   │   ├── fake-gcp-runtime.adapter.ts
│   │   │   │   │   ├── gcp-deployment-targets.repository.ts
│   │   │   │   │   ├── gcp-provisioning.executor.ts
│   │   │   │   │   ├── gcp-provisioning.service.ts
│   │   │   │   │   ├── gcp-runtime.port.ts
│   │   │   │   │   ├── gcp.module.ts
│   │   │   │   │   ├── gcp.provider.ts
│   │   │   │   │   └── provisioning-jobs.repository.ts
│   │   │   │   ├── legacy/
│   │   │   │   │   ├── legacy-deployment-providers.module.ts
│   │   │   │   │   └── legacy-deployment.provider.ts
│   │   │   │   ├── render/
│   │   │   │   │   └── render-env.client.ts
│   │   │   │   └── vercel/
│   │   │   │       └── vercel-env.client.ts
│   │   │   ├── custom-domains.repository.ts
│   │   │   ├── deployment-targets.repository.ts
│   │   │   ├── env-vars.repository.ts
│   │   │   └── provider-connections.repository.ts
│   │   ├── presentation/
│   │   │   ├── custom-domains.controller.ts
│   │   │   ├── deployment-targets.controller.ts
│   │   │   ├── env-feature.guard.ts
│   │   │   ├── env-vars.controller.ts
│   │   │   └── provider-connections.controller.ts
│   │   ├── deployments.module.ts
│   │   └── index.ts
│   ├── existing-repos/
│   │   ├── dto/
│   │   │   ├── discover-existing-repo.dto.ts
│   │   │   └── setup-existing-repo-pr.dto.ts
│   │   ├── existing-repos.controller.ts
│   │   ├── existing-repos.module.ts
│   │   ├── existing-repos.service.ts
│   │   └── index.ts
│   ├── feedback/
│   │   ├── dto/
│   │   │   └── submit-feedback.dto.ts
│   │   ├── feedback.controller.ts
│   │   ├── feedback.module.ts
│   │   ├── feedback.repository.ts
│   │   ├── feedback.service.ts
│   │   ├── feedback.types.ts
│   │   └── index.ts
│   ├── github/
│   │   ├── dto/
│   │   │   ├── create-repo.dto.ts
│   │   │   └── link-installation.dto.ts
│   │   ├── github-installations.repository.ts
│   │   ├── github-policy.constants.ts
│   │   ├── github-team-role-reconcile.worker.ts
│   │   ├── github-team-role.service.ts
│   │   ├── github-webhook.controller.ts
│   │   ├── github-workspace.types.ts
│   │   ├── github.controller.ts
│   │   ├── github.module.ts
│   │   ├── github.service.ts
│   │   └── index.ts
│   ├── hierarchy/
│   │   ├── assignments/
│   │   │   ├── assignments.controller.ts
│   │   │   ├── assignments.repository.ts
│   │   │   └── assignments.service.ts
│   │   ├── config-broker/
│   │   │   ├── providers/
│   │   │   │   └── github-secrets.provider.ts
│   │   │   ├── repo-config-broker.controller.ts
│   │   │   ├── repo-config-broker.service.ts
│   │   │   └── repo-configuration-changes.repository.ts
│   │   ├── delivery-projects/
│   │   │   ├── delivery-projects.controller.ts
│   │   │   ├── delivery-projects.repository.ts
│   │   │   └── delivery-projects.service.ts
│   │   ├── dto/
│   │   │   ├── add-group-member.dto.ts
│   │   │   ├── create-assignment.dto.ts
│   │   │   ├── create-delivery-project.dto.ts
│   │   │   ├── create-group.dto.ts
│   │   │   ├── create-repository.dto.ts
│   │   │   ├── create-system.dto.ts
│   │   │   ├── query-activity.dto.ts
│   │   │   ├── remove-member.dto.ts
│   │   │   ├── transfer-group.dto.ts
│   │   │   ├── update-delivery-project.dto.ts
│   │   │   ├── update-group.dto.ts
│   │   │   ├── update-member-role.dto.ts
│   │   │   ├── update-repository.dto.ts
│   │   │   ├── update-system.dto.ts
│   │   │   └── write-configuration.dto.ts
│   │   ├── github-sync/
│   │   │   ├── providers/
│   │   │   │   ├── github-team-access.live.ts
│   │   │   │   ├── github-team-access.provider.ts
│   │   │   │   └── github-team-access.stub.ts
│   │   │   ├── github-access-sync.repository.ts
│   │   │   ├── github-sync-outbox.worker.ts
│   │   │   └── github-sync.service.ts
│   │   ├── groups/
│   │   │   ├── group-members.service.ts
│   │   │   ├── groups.controller.ts
│   │   │   ├── groups.repository.ts
│   │   │   └── groups.service.ts
│   │   ├── project-link/
│   │   │   ├── hierarchy-project-link.module.ts
│   │   │   ├── hierarchy-project-link.repository.ts
│   │   │   ├── hierarchy-project-link.service.ts
│   │   │   └── index.ts
│   │   ├── repositories/
│   │   │   ├── repositories.controller.ts
│   │   │   ├── repositories.repository.ts
│   │   │   └── repositories.service.ts
│   │   ├── systems/
│   │   │   ├── systems.controller.ts
│   │   │   ├── systems.repository.ts
│   │   │   └── systems.service.ts
│   │   ├── group-activity.repository.ts
│   │   ├── group-activity.service.ts
│   │   ├── hierarchy-access.service.ts
│   │   ├── hierarchy.module.ts
│   │   ├── hierarchy.types.ts
│   │   ├── index.ts
│   │   └── me.controller.ts
│   ├── notifications/
│   │   ├── api/
│   │   │   └── notifications.controller.ts
│   │   ├── application/
│   │   │   ├── notification-events.service.ts
│   │   │   └── notifications.service.ts
│   │   ├── infra/
│   │   │   └── notifications.repository.ts
│   │   ├── index.ts
│   │   ├── notifications.module.ts
│   │   └── notifications.types.ts
│   ├── projects/
│   │   ├── application/
│   │   │   ├── deployment-provisioning.policy.ts
│   │   │   ├── deployment-workflow-targets.ts
│   │   │   ├── generated-repo-readme.ts
│   │   │   ├── product-events.service.ts
│   │   │   ├── project-dashboard.service.ts
│   │   │   ├── project-drift-repair.service.ts
│   │   │   ├── project-lifecycle.service.ts
│   │   │   ├── project-overview.view.ts
│   │   │   ├── project-previews.service.ts
│   │   │   ├── project-provisioning.service.ts
│   │   │   ├── project-workflow-files.service.ts
│   │   │   ├── project-workflows.service.ts
│   │   │   ├── provisioning-token.service.ts
│   │   │   ├── setup-branch.service.ts
│   │   │   ├── sonar-cloud-setup.service.ts
│   │   │   └── workspace-gate.service.ts
│   │   ├── dto/
│   │   │   ├── create-project.dto.ts
│   │   │   ├── disconnect-project.dto.ts
│   │   │   └── setup-project.dto.ts
│   │   ├── index.ts
│   │   ├── local-ci-runs.provider.ts
│   │   ├── project-ci-runs.service.ts
│   │   ├── project-ci-runs.types.ts
│   │   ├── project-dashboard-snapshots.repository.ts
│   │   ├── project-drift-repair.service.ts
│   │   ├── project-previews.service.ts
│   │   ├── project-previews.types.ts
│   │   ├── project-reference.module.ts
│   │   ├── project-workflow-settings.repository.ts
│   │   ├── project-workflow-update-requests.repository.ts
│   │   ├── project-workspace.controller.ts
│   │   ├── project-workspace.service.ts
│   │   ├── projects.controller.ts
│   │   ├── projects.module.ts
│   │   ├── projects.repository.ts
│   │   ├── projects.service.ts
│   │   ├── projects.service.types.ts
│   │   ├── scaffold.builder.ts
│   │   └── url-embeddability.probe.ts
│   ├── subscription/
│   │   ├── dto/
│   │   │   └── activate-subscription.dto.ts
│   │   ├── infra/
│   │   │   └── subscriptions.repository.ts
│   │   ├── index.ts
│   │   ├── subscription.contracts.ts
│   │   ├── subscription.controller.ts
│   │   ├── subscription.module.ts
│   │   └── subscription.service.ts
│   ├── usage/
│   │   ├── index.ts
│   │   ├── usage-quota.service.ts
│   │   ├── usage.controller.ts
│   │   ├── usage.module.ts
│   │   └── usage.types.ts
│   ├── workflows/
│   │   ├── dto/
│   │   │   └── generate-workflow.dto.ts
│   │   ├── infra/
│   │   │   └── workflow-history.repository.ts
│   │   ├── index.ts
│   │   ├── staged-workflow.builder.ts
│   │   ├── workflows.contracts.ts
│   │   ├── workflows.controller.ts
│   │   ├── workflows.module.ts
│   │   └── workflows.service.ts
│   ├── workspaces/
│   │   ├── index.ts
│   │   ├── workspace-access.service.ts
│   │   ├── workspaces.controller.ts
│   │   ├── workspaces.module.ts
│   │   ├── workspaces.repository.ts
│   │   └── workspaces.service.ts
│   └── README.md
├── scripts/
│   ├── process-outbox.cjs        # compiled application-context relay
│   └── reconcile-deleted-repos.ts
├── types/
│   ├── express-session.d.ts
│   └── libsodium-wrappers.d.ts
├── app.controller.ts
├── app.module.ts
├── app.service.ts
└── main.ts
```

## 3. Target: six contexts

### 3.1 Mapping

| Future context | Absorbs | Files | Lines |
|---|---|---:|---:|
| `projects` | `projects`, `catalog`, `workflows`, `existing-repos` | 81 | 22,217 |
| `runtime` | `deployments` (targets, env vars, domains, all providers) | 97 | 17,795 |
| `identity-access` | `auth`, `admin`, `capabilities`, `workspaces`, `hierarchy` | 95 | 14,347 |
| `pipelines` | `github`, `ci` | 33 | 8,095 |
| `billing` | `subscription`, `usage` | 17 | 1,673 |
| `platform-ops` | `notifications`, `feedback`, `audit` | 20 | 1,130 |

Same six-context grouping as `DDD_CONTEXT_MAP.md` and the rejected
split-services doc — deliberately, so the two documents cannot drift into
describing different systems.

### 3.2 Coupling after consolidation

| Metric | Now | After | Delta |
|---|---:|---:|---|
| Modules | 17 | 6 | −65% |
| Directional context pairs | 40 historical module edges | 15 current context pairs | not directly comparable |
| Cross-context import statements | 135 historical module imports | 32 alias-aware imports, all composition-only | not directly comparable |

28 import statements stop crossing a boundary entirely — they become ordinary
intra-context calls:

| Count | Edge that disappears | Absorbed into |
|---:|---|---|
| 12 | `projects -> workflows` | `projects` |
| 4 | `projects -> catalog` | `projects` |
| 3 | `hierarchy -> admin` | `identity-access` |
| 3 | `workflows -> catalog` | `projects` |
| 2 | `auth -> admin` | `identity-access` |
| 2 | `existing-repos -> catalog` | `projects` |
| 1 | `hierarchy -> auth` | `identity-access` |
| 1 | `hierarchy -> workspaces` | `identity-access` |

Current alias-aware cross-context imports after the review-closure work:

| Count | Edge |
|---:|---|
| 8 | `identity-access -> billing`, `identity-access -> pipelines`, `identity-access -> platform-ops`, `identity-access -> projects`, `identity-access -> runtime` |
| 1 | `pipelines -> platform-ops` |
| 15 | `projects -> billing`, `projects -> identity-access`, `projects -> pipelines`, `projects -> platform-ops`, `projects -> runtime` |
| 8 | `runtime -> billing`, `runtime -> identity-access`, `runtime -> pipelines`, `runtime -> platform-ops` |

These counts sum to 32 file-level imports across 15 directional pairs. All are
explicit Nest composition wiring; the metrics report zero contract,
application, and actionable cross-context imports. The contract register in
`CROSS_CONTEXT_CONTRACTS.md` remains the governing list of conceptual edges.

The scanner is a trend report, not a service-extraction proof. The remaining
composition imports are expected in one NestJS deployable; dependency-cruiser
remains authoritative for the actual file graph and reports zero violations.

### 3.3 Cycle closure

The consolidation surfaced two context-level cycles that had been hidden as
module-level edges. Both are now governed by context-root composition and
focused ports; they remain documented as current in-process edges rather than
as application-level cycles:

**Cycle A — `identity-access` ⇄ `projects`**

| Direction | Evidence |
|---|---|
| `identity-access -> projects` | `ProjectLookupPort` plus context-root composition for the project lookup adapter |
| `projects -> identity-access` | public identity-access indexes and project-link/workspace ports |

**Cycle B — `identity-access` ⇄ `pipelines`**

| Direction | Evidence |
|---|---|
| `identity-access -> pipelines` | public pipelines index and GitHub/CI contracts, composed by the identity-access root |
| `pipelines -> identity-access` | inverted through a focused kernel port; no current pipelines-to-identity context edge is reported |

The current context roots and dependency-cruiser graph have no circular
violations. The alias-aware metrics report 32 cross-context imports, all
composition-only, with zero contract/application/actionable edges.

### 3.4 Extraction readiness ranking

Fan-in is what makes a service extractable; fan-out only makes it chatty.

| Context | Inbound context pairs | Outbound context pairs | Current posture |
|---|---:|---:|---|
| `platform-ops` | 0 | 0 | sink-shaped; event consumer, but still in the monolith |
| `billing` | 0 | 0 | self-contained in the current composition graph |
| `runtime` | 4 | 4 | provider/deployment context; extraction candidate only after a real trigger |
| `pipelines` | 1 | 1 | webhook/CI context with platform event output |
| `identity-access` | 5 | 5 | policy context with explicit composition fan-out |
| `projects` | 5 | 5 | orchestrator; extract last or never |

These are current directional context-pair counts from the alias-aware metric;
they describe the in-process composition graph, not independently deployable
services.

## 4. The seam that makes a split cheap

The whole point of the target layout is one rule:

> **A context may only reach another context through `contracts/` types and an
> injected client port. Never a service class, never a repository, never a
> DTO from `api/`.**

`contracts/` holds nothing but serialisable types and port interfaces — no
Nest decorators, no `pg`, no vendor SDKs. Which gives:

| Today (monolith) | Later (split) | What changes |
|---|---|---|
| `RuntimeClient` bound to a local in-process adapter | bound to an HTTP/gRPC adapter | one provider binding in `*.module.ts` |
| `contracts/*.ts` imported directly | published as a shared package or generated from OpenAPI | build wiring only |
| Domain events written to `kernel/events` outbox, dispatched in-process | same outbox, relayed to a broker | the relay, not the producers |

Call-site code does not change in either case. That is the entire deliverable
of this plan; the folder moves are just how you get there.

Corollary rules:

- Cross-context reads that tolerate staleness should be **events**, not calls.
  The current event-sink edges into `platform-ops` (audit, notifications) are
  all of this kind and should remain outbox events. This reduces synchronous
  application coupling without pretending the remaining in-process graph is
  already a service mesh.
- Cross-context writes stay synchronous through a port. Do not invent sagas for
  a monolith.
- No context may import another context's database tables. Schema ownership is
  tagged in Phase 4 so this is checkable.

## 5. Three axes of modularity (where providers actually live)

"Modular" in this codebase means three different things that must not be
conflated. Deployment providers are the clearest example: they are *not* a
seventh context. They remain a variation axis inside `runtime`; the
review-closure work improves their contribution seams without turning them
into top-level contexts.

| # | Axis | Unit | Count today | Governed by | Changes when |
|---|---|---|---:|---|---|
| 1 | **Context** | bounded business capability | 17 → 6 | this document | the business gains a new capability |
| 2 | **Plugin** | variation point *inside* one context | 3 providers | `docs/modular-architecture-deployments.md` | a new vendor is integrated |
| 3 | **Deployment mode** | which surface is enabled per install | ~20 `*_ENABLED` flags | `src/config/app.config.ts` | an edition (SaaS / edu / enterprise / on-prem) turns a feature on or off |

Deployment providers are **axis 2**. The acceptance test for that claim is now
implemented at the registry/builder seam:

> A fourth provider can register metadata, a runtime client, a workflow
> fragment, and a CI installer by id without changing another context or adding
> a vendor branch to the workflow builder.

The production composition still needs one Runtime provider-module binding, and
legacy Render/Vercel compatibility fields remain. The fake-provider acceptance
test proves the generic extension point, not zero-edit persistence migration.

### 5.1 The provider seam as it actually exists

There are **four contribution registries**, each with one generic variation
point:

| Registry | Location | Purpose | Open/closed? |
|---|---|---|---|
| `DeploymentProviderRegistry` | `runtime/core/` | metadata: id, label, slots, capabilities, config + credential schemas | **yes** — providers register at Runtime composition |
| `ProviderClientRegistry` | `runtime/infrastructure/providers/core/` | runtime I/O client selection | **yes** — map keyed by open provider id |
| `ProviderCiSecretsInstallerRegistry` | `runtime/infrastructure/providers/core/` | provider-owned CI secret installation | **yes** — map keyed by open provider id |
| `WorkflowFragmentRegistry` | `runtime/infrastructure/providers/core/` | provider-owned workflow target expansion and job fragments | **yes** — map keyed by open provider id; expansion fails closed when absent |

The provider id and workflow/deployment strategy types are open strings where
the public API already accepts provider data. Render/Vercel compatibility
classes and the parallel GCP runtime remain inside Runtime; they are not
exposed to other contexts.

### 5.2 Provider identity leaks across the context boundary

This is where axis 1 and axis 2 used to collide. The historical leaks are
listed below because they explain the compatibility debt; the current code
keeps provider implementations and policy inside `runtime`:

| File | Lands in context | Current status |
|---|---|---|
| provider-specific workflow generation | `projects` | moved behind `WorkflowFragmentRegistry`; the builder has no vendor branches |
| provider discovery | `identity-access` | reads Runtime registry; no hardcoded provider list |
| provider DTO id | `projects` | open provider string; legacy provider-owned fields remain for wire compatibility |
| usage/quota compatibility keys | `billing` | existing response keys remain; provider policy stays in Runtime-facing compatibility seams |
| Render/Vercel target strategy and secret names | `projects`/`runtime` | workflow target expansion, slot wording, and provider metadata links are now provider-owned; legacy token/scope/storage/strategy mappings remain explicit compatibility code |

The remaining provider-related imports are data contracts or compatibility
fields, not provider adapters. A new provider must extend Runtime composition
and its own contribution maps; it must not add vendor logic to another
context. Provider metadata classes now live in their provider folders, slot
validation is descriptor-driven, and workflow target expansion fails closed
when a registered provider has no expansion contribution. Legacy token,
scope, storage-column, and strategy identifiers stay in Runtime until the
separate persistence/compatibility extraction is approved. The gate and
fake-provider acceptance test make that rule visible.

### 5.3 The rule that keeps the axes independent

> **Provider identity is private to `runtime`.** No other context's
> `contracts/`, DTO, SQL, or workflow builder may name a provider.

What each historical leak turns into:

| Leak | Becomes |
|---|---|
| `billing` quota SQL | counts by ownership mode + a `DeploymentUsageFact` contract published by `runtime`, not by `provider = 'render'` |
| `capabilities` provider list | reads the existing `GET /deployment-providers` discovery endpoint, which the metadata registry already backs |
| `workflows` deploy jobs | each provider adapter contributes a workflow fragment + its own secret-name list; the builder composes fragments it does not understand |
| `projects` DTO validation | open provider data at the transport boundary; Runtime validates provider/slot/config against its registry |

Note that three of the four fixes are *already possible* with the metadata
registry that exists. This is mostly wiring, not new architecture.

### 5.4 How provider work maps onto the phases

| Phase | Provider-axis work |
|---|---|
| 0 | Add gate `no-provider-literals-outside-runtime`; the current gate is an error with one documented public DTO exception |
| 1 | `DeploymentUsageFact` and `WorkflowFragment` are two of the 16 cross-context contracts |
| 3.6 | Providers move with `runtime`; Render/Vercel metadata adapters and workflow contributions remain under `infrastructure/providers/` |
| 4 | Decide whether `env_provisioning.*` and `runtime_deployments.*` converge on one `provider_config JSONB` table, or stay forked |
| — | Provider persistence convergence and removal of legacy compatibility fields remain out of scope; see `docs/modular-architecture-deployments.md` |

### 5.5 The third axis: deployment mode

Providers already demonstrate the pattern the SaaS / edu / enterprise split
needs:

- `GcpDeploymentProvider.isEnabled()` returns `{ enabled: false, reason }` when
  `GCP_DEPLOYMENTS_ENABLED` is unset — the provider is present but inert, and
  says why.
- `GCP_RUNTIME_ADAPTER` binds `GoogleCloudRuntimeAdapter` or
  `FakeGcpRuntimeAdapter` from the same flag — one image, two behaviours.

That is the model: a capability is **compiled in and config-gated**, never
forked per edition. Applied to contexts, it produces one consequence for this
plan — a context that can be switched off must be **absent-tolerant at the port
level**, so its consumers degrade rather than fail to construct. `billing` is
the live case (open decision 3).


## 6. Full future-state tree

```text
src/
├── main.ts                                   # bootstrap only
├── app.module.ts                             # composition root: 6 context modules
├── health/
│   ├── health.controller.ts
│   ├── health.service.ts
│   └── health.module.ts
├── kernel/                                   # technical shared infrastructure; never business
│   ├── auth/
│   │   ├── session-auth.guard.ts
│   │   ├── subscription.guard.ts
│   │   ├── dev-only.guard.ts
│   │   └── session-user-lookup.contract.ts
│   ├── config/
│   │   ├── app.config.ts
│   │   ├── env.validation.ts
│   │   └── security.config.ts
│   ├── db/
│   │   ├── database.module.ts
│   │   ├── database.service.ts
│   │   ├── postgres-ssl.config.ts
│   │   └── supabase/
│   ├── events/
│   │   ├── events.module.ts
│   │   ├── outbox.repository.ts
│   │   ├── outbox-dispatcher.ts
│   │   ├── outbox-topics.ts
│   │   ├── platform-event.registry.ts
│   │   └── platform-event-publisher.ts
│   ├── http/
│   │   ├── all-exceptions.filter.ts
│   │   └── correlation-id.middleware.ts
│   └── types/
│
├── modules/
│   │
│   ├── identity-access/                      # auth + admin + capabilities + workspaces + hierarchy
│   │   ├── api/
│   │   │   ├── auth.controller.ts
│   │   │   ├── admin.controller.ts
│   │   │   ├── capabilities.controller.ts
│   │   │   ├── workspaces.controller.ts
│   │   │   ├── me.controller.ts
│   │   │   ├── groups.controller.ts
│   │   │   ├── systems.controller.ts
│   │   │   ├── assignments.controller.ts
│   │   │   ├── delivery-projects.controller.ts
│   │   │   ├── repositories.controller.ts
│   │   │   ├── repo-config-broker.controller.ts
│   │   │   ├── guards/
│   │   │   │   ├── platform-admin.guard.ts
│   │   │   │   └── super-admin.guard.ts
│   │   │   └── dto/                          # all current admin/ + hierarchy/ DTOs
│   │   ├── application/
│   │   │   ├── auth/
│   │   │   │   ├── auth.service.ts
│   │   │   │   └── session-user-lookup.adapter.ts
│   │   │   ├── admin/
│   │   │   │   ├── admin.service.ts
│   │   │   │   ├── platform-admin-access.service.ts
│   │   │   │   └── admin-user.view.ts
│   │   │   ├── workspaces/
│   │   │   │   ├── workspaces.service.ts
│   │   │   │   └── workspace-access.service.ts
│   │   │   ├── hierarchy/
│   │   │   │   ├── groups.service.ts
│   │   │   │   ├── group-members.service.ts
│   │   │   │   ├── group-activity.service.ts
│   │   │   │   ├── systems.service.ts
│   │   │   │   ├── assignments.service.ts
│   │   │   │   ├── delivery-projects.service.ts
│   │   │   │   ├── repositories.service.ts
│   │   │   │   ├── hierarchy-access.service.ts
│   │   │   │   └── project-link.service.ts
│   │   │   ├── config-broker/
│   │   │   │   └── repo-config-broker.service.ts
│   │   │   ├── github-sync/
│   │   │   │   ├── github-sync.service.ts
│   │   │   │   └── github-sync-outbox.worker.ts
│   │   │   └── ports/
│   │   │       ├── repo-host.port.ts         # was: hierarchy -> github/index
│   │   │       ├── repo-secrets.port.ts      # was: github-secrets.provider
│   │   │       └── project-lookup.port.ts    # was: hierarchy -> projects/index (Cycle A)
│   │   ├── domain/                           # membership, role, and transfer invariants only
│   │   │   ├── group-membership.policy.ts
│   │   │   └── hierarchy-access.policy.ts
│   │   ├── infrastructure/
│   │   │   ├── repositories/
│   │   │   │   ├── users.repository.ts
│   │   │   │   ├── oauth-state.repository.ts
│   │   │   │   ├── admin.repository.ts
│   │   │   │   ├── platform-admins.repository.ts
│   │   │   │   ├── workspaces.repository.ts
│   │   │   │   ├── groups.repository.ts
│   │   │   │   ├── systems.repository.ts
│   │   │   │   ├── assignments.repository.ts
│   │   │   │   ├── delivery-projects.repository.ts
│   │   │   │   ├── repositories.repository.ts
│   │   │   │   ├── group-activity.repository.ts
│   │   │   │   ├── hierarchy-project-link.repository.ts
│   │   │   │   ├── repo-configuration-changes.repository.ts
│   │   │   │   └── github-access-sync.repository.ts
│   │   │   └── adapters/
│   │   │       ├── github-team-access.live.ts
│   │   │       ├── github-team-access.stub.ts
│   │   │       └── github-secrets.adapter.ts
│   │   ├── contracts/                        # serialisable; the future network API
│   │   │   ├── session-user.contract.ts
│   │   │   ├── workspace-access.contract.ts
│   │   │   ├── platform-admin.contract.ts
│   │   │   ├── hierarchy-project-link.contract.ts
│   │   │   └── events.ts
│   │   ├── identity-access.module.ts
│   │   └── index.ts
│   │
│   ├── projects/                             # projects + catalog + workflows + existing-repos
│   │   ├── api/
│   │   │   ├── projects.controller.ts
│   │   │   ├── project-workspace.controller.ts
│   │   │   ├── catalog.controller.ts
│   │   │   ├── workflows.controller.ts
│   │   │   ├── existing-repos.controller.ts
│   │   │   └── dto/
│   │   ├── application/
│   │   │   ├── lifecycle/
│   │   │   │   ├── projects.service.ts       # 504-line compatibility facade
│   │   │   │   ├── project-provisioning-application.service.ts # largest focused setup orchestrator
│   │   │   │   ├── project-lifecycle.service.ts
│   │   │   │   ├── project-provisioning.service.ts
│   │   │   │   ├── setup-branch.service.ts
│   │   │   │   ├── sonar-cloud-setup.service.ts
│   │   │   │   └── provisioning-token.service.ts
│   │   │   ├── dashboard/
│   │   │   │   ├── project-dashboard.service.ts
│   │   │   │   ├── project-overview.view.ts
│   │   │   │   ├── project-previews.service.ts
│   │   │   │   └── project-ci-runs.service.ts
│   │   │   ├── drift/
│   │   │   │   └── project-drift-repair.service.ts
│   │   │   ├── workflows/
│   │   │   │   ├── workflows.service.ts
│   │   │   │   ├── project-workflows.service.ts
│   │   │   │   ├── project-workflow-files.service.ts
│   │   │   │   ├── staged-workflow.builder.ts
│   │   │   │   └── deployment-workflow-targets.ts
│   │   │   ├── catalog/
│   │   │   │   └── catalog.service.ts
│   │   │   ├── existing-repos/
│   │   │   │   └── existing-repos.service.ts
│   │   │   ├── workspace-gate.service.ts
│   │   │   ├── product-events.service.ts
│   │   │   └── ports/
│   │   │       ├── deployment-provisioning.port.ts   # -> runtime
│   │   │       ├── deployment-history.port.ts        # -> runtime
│   │   │       ├── repo-host.port.ts                 # -> pipelines
│   │   │       ├── ci-runs.port.ts                   # -> pipelines
│   │   │       ├── workspace-access.port.ts          # -> identity-access
│   │   │       └── quota.port.ts                     # -> billing
│   │   ├── domain/
│   │   │   ├── project-status.ts
│   │   │   ├── deployment-provisioning.policy.ts
│   │   │   ├── scaffold.builder.ts
│   │   │   └── generated-repo-readme.ts
│   │   ├── infrastructure/
│   │   │   ├── repositories/
│   │   │   │   ├── projects.repository.ts
│   │   │   │   ├── project-dashboard-snapshots.repository.ts
│   │   │   │   ├── project-workflow-settings.repository.ts
│   │   │   │   ├── project-workflow-update-requests.repository.ts
│   │   │   │   └── workflow-history.repository.ts
│   │   │   ├── clients/
│   │   │   │   └── url-embeddability.probe.ts
│   │   │   └── adapters/                     # in-process bindings for the ports above
│   │   │       ├── local-ci-runs.provider.ts
│   │   │       ├── local-deployment-history.provider.ts
│   │   │       └── deployment-provisioning.adapter.ts
│   │   ├── contracts/
│   │   │   ├── project-reference.contract.ts
│   │   │   ├── project-workflow.contract.ts
│   │   │   ├── catalog.contract.ts
│   │   │   └── events.ts
│   │   ├── projects.module.ts
│   │   └── index.ts
│   │
│   ├── pipelines/                            # github + ci
│   │   ├── api/
│   │   │   ├── github.controller.ts
│   │   │   ├── github-webhook.controller.ts
│   │   │   ├── ci.controller.ts
│   │   │   └── dto/
│   │   ├── application/
│   │   │   ├── github/
│   │   │   │   ├── github.service.ts
│   │   │   │   └── github-team-role.service.ts
│   │   │   ├── ci/
│   │   │   │   ├── ci.service.ts
│   │   │   │   ├── ci-reports.service.ts
│   │   │   │   └── translate-results.ts
│   │   │   ├── workers/
│   │   │   │   └── github-team-role-reconcile.worker.ts
│   │   │   └── ports/
│   │   │       └── platform-admin.port.ts    # was: github -> admin/index (Cycle B)
│   │   ├── domain/
│   │   │   ├── github-policy.constants.ts
│   │   │   └── ci-run-status.ts
│   │   ├── infrastructure/
│   │   │   └── repositories/
│   │   │       ├── github-installations.repository.ts
│   │   │       ├── ci-tokens.repository.ts
│   │   │       └── ci-run-reports.repository.ts
│   │   ├── contracts/
│   │   │   ├── github-installation.contract.ts
│   │   │   ├── github-workspace.types.ts
│   │   │   ├── ci.contracts.ts
│   │   │   └── events.ts
│   │   ├── pipelines.module.ts
│   │   └── index.ts
│   │
│   ├── runtime/                              # deployments: targets, env vars, domains, providers
│   │   ├── api/
│   │   │   ├── deployment-targets.controller.ts
│   │   │   ├── provider-connections.controller.ts
│   │   │   ├── env-vars.controller.ts
│   │   │   ├── custom-domains.controller.ts
│   │   │   ├── deployment-providers.controller.ts
│   │   │   ├── env-feature.guard.ts
│   │   │   └── dto/
│   │   ├── application/
│   │   │   ├── deployment-targets.service.ts
│   │   │   ├── provider-connections.service.ts
│   │   │   ├── env-vars.service.ts
│   │   │   ├── custom-domains.service.ts
│   │   │   ├── project-deployments.service.ts
│   │   │   ├── project-deployment-provisioning.service.ts
│   │   │   ├── project-drift.service.ts
│   │   │   ├── encryption.service.ts
│   │   │   └── ports/
│   │   │       ├── project-reference.port.ts # -> projects (read-only reference)
│   │   │       ├── quota.port.ts             # -> billing
│   │   │       └── provider-ci-secrets-installer.port.ts # provider-owned CI contribution
│   │   ├── domain/
│   │   │   ├── deployment-target.policy.ts
│   │   │   ├── deployment-strategy.resolver.ts
│   │   │   ├── environment-scope.ts
│   │   │   └── provider-connection.ts
│   │   ├── core/
│   │   │   ├── deployment-provider.contract.ts
│   │   │   ├── deployment-provider.registry.ts
│   │   │   ├── deployment-provisioning.contract.ts
│   │   │   ├── deployments.types.ts
│   │   │   └── workflow-fragment.contract.ts
│   │   ├── infrastructure/
│   │   │   ├── repositories/
│   │   │   │   ├── deployment-targets.repository.ts
│   │   │   │   ├── provider-connections.repository.ts
│   │   │   │   ├── env-vars.repository.ts
│   │   │   │   ├── custom-domains.repository.ts
│   │   │   │   └── project-sync-findings.repository.ts
│   │   │   └── providers/
│   │   │       ├── core/
│   │   │       │   ├── default-workflow-fragment-registry.ts
│   │   │       │   ├── legacy-provider.shared.ts
│   │   │       │   ├── provider-client.registry.ts
│   │   │       │   ├── provider-ci-secrets.registry.ts
│   │   │       │   └── workflow-fragment.registry.ts
│   │   │       ├── gcp/
│   │   │       ├── render/
│   │   │       │   ├── render-deployment.provider.ts
│   │   │       │   ├── render-env.client.ts
│   │   │       │   ├── render-ci-secrets.service.ts
│   │   │       │   ├── render-cost-policy.service.ts
│   │   │       │   └── render-workflow.fragment.ts
│   │   │       ├── vercel/
│   │   │       │   ├── vercel-deployment.provider.ts
│   │   │       │   ├── vercel-env.client.ts
│   │   │       │   ├── vercel-ci-secrets.service.ts
│   │   │       │   └── vercel-workflow.fragment.ts
│   │   │       └── legacy/
│   │   │           └── legacy-deployment-providers.module.ts # compatibility composition only
│   │   ├── contracts/
│   │   │   ├── deployment-provider.contract.ts
│   │   │   ├── deployment-provider-runtime.contract.ts
│   │   │   ├── deployment-provisioning.contract.ts
│   │   │   ├── deployments.types.ts
│   │   │   └── events.ts
│   │   ├── runtime.module.ts
│   │   └── index.ts
│   │
│   ├── billing/                              # subscription + usage
│   │   ├── api/
│   │   │   ├── subscription.controller.ts
│   │   │   ├── usage.controller.ts
│   │   │   └── dto/
│   │   ├── application/
│   │   │   ├── subscription.service.ts
│   │   │   └── usage-quota.service.ts
│   │   ├── domain/
│   │   │   └── quota.policy.ts
│   │   ├── infrastructure/
│   │   │   └── repositories/
│   │   │       └── subscriptions.repository.ts
│   │   ├── contracts/
│   │   │   ├── subscription.contracts.ts
│   │   │   ├── usage.types.ts
│   │   │   └── events.ts
│   │   ├── billing.module.ts
│   │   └── index.ts
│   │
│   └── platform-ops/                         # notifications + feedback + audit
│       ├── api/
│       │   ├── notifications.controller.ts
│       │   ├── feedback.controller.ts
│       │   └── dto/
│       ├── application/
│       │   ├── notifications.service.ts
│       │   ├── notification-events.service.ts
│       │   ├── feedback.service.ts
│       │   ├── audit-events.service.ts
│       │   └── outbox-relay.service.ts
│       ├── infrastructure/
│       │   └── repositories/
│       │       ├── notifications.repository.ts
│       │       ├── feedback.repository.ts
│       │       └── audit-events.repository.ts
│       ├── contracts/
│       │   ├── notification.contract.ts
│       │   ├── audit-event.contract.ts
│       │   └── feedback.types.ts
│       ├── platform-ops.module.ts
│       └── index.ts
│
├── scripts/
│   ├── process-outbox.cjs        # compiled application-context relay
│   ├── route-inventory.cjs       # diffable Swagger route table
│   └── reconcile-deleted-repos.ts
└── types/
```

Notes on the tree:

- `src/common/` disappears: guards, filters, middleware, and config move to
  `kernel/{auth,http,config}`. `src/config/` merges into `kernel/config/`.
- `domain/` exists only where a named invariant exists. `platform-ops` gets no
  domain folder at all, and `billing` gets only `quota.policy.ts`. Empty layers
  are a violation, not a convention.
- Naming is normalised to `api | application | domain | infrastructure |
  contracts`. The current `presentation/` and `infra/` spellings both go away.
- `deployments` is renamed `runtime` to match the context map. This is the only
  rename that touches a large number of import paths; it can be deferred behind
  a re-export barrel if the diff is too large to review.

## 7. Phased sequence

Each phase is independently mergeable and behaviour-preserving. The verification
baseline is typecheck, changed-file lint, Jest, and dependency boundaries;
global lint is reported separately when the repository's pre-existing baseline
contains findings.

### Phase 0 — Freeze the rules (docs + gates, no moves)

- Add a `context` tag per module in `.dependency-cruiser.cjs` so context-level
  rules can be written while the folders are still 17.
- Add rule `no-cross-context-cycles` at `warn` severity.
- Add rule `contracts-are-dependency-free`: nothing under `*/contracts/` may
  import `@nestjs/*`, `pg`, `@supabase/*`, or any `infrastructure/` path.
- Move app-wide guards (`session-auth`, `subscription`, `dev-only`) from
  `src/common/guards/` to `kernel/auth/` so Phase 3.4 does not have to.
- Add rule `no-provider-literals-outside-runtime` at `warn` (see §5.4).
- Exit: gates land green with the existing 0-violation baseline unchanged.

### Phase 1 — Introduce the seam, keep the folders

- For each of the 16 current directional cross-context edges, define the `contracts/` type and the
  consumer-side port. Bind each port to a local adapter in the owning
  `*.module.ts`.
- No file moves. Consumers switch from `import { XService } from '../x'` to an
  injected port token.
- Exit: every cross-context import resolves to a `contracts/` path or a Nest
  token, never a service class.

### Phase 2 — Break the two cycles

- **Cycle A:** invert `hierarchy -> projects`. `repositories.service.ts` gets a
  `ProjectLookupPort`; `hierarchy.module.ts` and `auth.module.ts` stop importing
  `projects.module.ts` (Nest composition imports count as cycles once contexts
  are the unit).
- **Cycle B:** invert `github -> admin`. `github-team-role.service.ts` takes a
  `PlatformAdminPort` instead of importing `admin/index`.
- Exit: `no-cross-context-cycles` promoted from `warn` to `error`.

### Phase 3 — Physical consolidation, one context per PR

Ordered by ascending blast radius, so the pattern is proven on cheap moves:

| # | Context | Modules folded | Risk |
|---|---|---|---|
| 3.1 | `platform-ops` | notifications, feedback, audit | low — 1,130 lines, 0 outbound |
| 3.2 | `billing` | subscription, usage | low — 1,673 lines, 0 outbound |
| 3.3 | `pipelines` | github, ci | medium — webhook routes must not move |
| 3.4 | `identity-access` | auth, admin, capabilities, workspaces, hierarchy | high — 95 files, guards used app-wide |
| 3.5 | `projects` | projects, catalog, workflows, existing-repos | high — 22k lines, 12 outbound edges |
| 3.6 | `runtime` | deployments (rename) | medium — already layered; mostly a rename |

Per-PR rules: `git mv` only, no logic edits in the same commit; keep
compatibility re-exports at old `index.ts` paths until the last PR of the
phase; the known-violations baseline may shrink, never grow.

### Phase 4 — Schema ownership (implemented)

- Tag every table in the 63 `supabase/` migration files with its owning context.
- Add a SQL ownership gate: a repository under context X may not name a table
  owned by context Y. Import gates do not catch inline SQL — this is the known
  hole flagged in earlier architecture work.
- Exit: the ownership table is published and the gate is green. No schema
  change, no DB roles, no `search_path` tricks.

### Phase 5 — Async-ify the sink edges (implemented)

- Audit and notification write edges now publish serialisable events through the
  kernel outbox and are consumed in-process by `platform-ops`.
- `pg_try_advisory_lock` enforces one relay owner across processes; failed
  handlers remain pending and delivery is explicitly at-least-once.
- Security-sensitive always-on audit writes and audit reads remain synchronous by
  design. See `docs/architecture/CROSS_CONTEXT_CONTRACTS.md` for the exact
  exception list.

### Future-only reference — microservice extraction

Microservice extraction is not a phase or deliverable of this consolidation.
The current application remains one NestJS deployable with six bounded
contexts. If an independent scaling need, independent deploy cadence, or
regulatory isolation requirement is later demonstrated, use
`docs/architecture/FUTURE_STATE.md` as the separate extraction design starting
point. Runtime is currently the strongest candidate, but its measured graph
still has three inbound context pairs, four outbound pairs, and compatibility
seams; the directory count is not extraction proof.

Do not add HTTP transport adapters, service packages, broker infrastructure, or
schema splits as part of this plan. Nothing in `application/` or `domain/`
should change merely because a future transport eventually changes.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Big-bang rename breaks review | One context per PR, `git mv` only, re-export shims until phase end |
| Consolidation hides coupling instead of fixing it | Phase 1 seam lands *before* Phase 3 moves, so hidden coupling becomes typed ports first |
| `projects` stays a god-context | Decomposition of `projects.service.ts` continues independently; consolidation is not a substitute |
| Guards move and break auth | App-wide guards move to `kernel/auth` in Phase 0, not during 3.4 |
| Contexts become the new "too many folders" | 6 is the ceiling. Adding a 7th requires a written justification in this doc |
| Extraction never happens and the seam costs us | The current contract register and focused ports still pay for themselves through testability and explicit ownership |
| Provider axis gets confused with the context axis | §5 states the rule and Phase 0 adds a gate; a new vendor must never become a seventh context |
| Provider leaks make `billing`/`identity-access`/`projects` unbuildable without `runtime` | The four leaks in §5.2 are fixed in Phase 1 as ordinary cross-context contracts |

## 9. Open decisions

1. **`deployments` → `runtime` rename** — do it in Phase 3.6, or keep the name
   and accept the mismatch with the context map?
2. **`hierarchy` inside `identity-access`** — the earlier decision said yes. It
   is 7,146 lines and would make `identity-access` the third-largest context.
   Keep as agreed, or promote it to a seventh context?
3. **`billing` in enterprise installations** — still unresolved from the
   future-state doc. If billing ships only in SaaS, it is a config-gated context
   and its ports must tolerate absence.
4. **Does `capabilities` belong in `identity-access`?** It is 378 lines and
   reads as a platform-wide feature-flag surface, which is arguably
   `platform-ops`.
5. **Phase 4 sequencing** — schema ownership before or after the physical moves?
   Before is safer; after is faster.
6. **Do the two provider registries and the two `DeploymentProvider` interfaces
   converge?** (§5.1) Out of scope here, but the answer changes what `runtime`
   publishes in `contracts/`.
7. **Does `gcp` join `EnvProvider` and the `env_provisioning` tables, or stay a
   parallel stack?** Convergence makes the provider axis genuinely open;
   staying forked means every new provider picks a side.

## 10. Related documents

- `docs/architecture/FUTURE_STATE.md` — records the rejection of split services
- `docs/architecture/DDD_CONTEXT_MAP.md` — bounded contexts and ubiquitous language
- `docs/superpowers/plans/2026-08-25-modular-monolith-boundary-restoration.md` — the boundary work this builds on
- `docs/modular-architecture-deployments.md` — the provider plugin architecture (axis 2)
- `src/modules/README.md` — the per-module convention this plan supersedes
