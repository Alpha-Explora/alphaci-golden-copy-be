# Backend Architecture Alignment Review

**Date:** 2026-08-25  
**Mode:** architecture review and implementation verification  
**Scope:** alphaci-enterprise-be; behavior-preserving modular-monolith refactor

## Outcome

The backend is now **aligned with the approved progressive hexagonal-clean
modular-monolith target** on the isolated implementation branch.

NestJS still has one composition root, feature ownership remains explicit, and
`.dependency-cruiser.cjs` now enforces the public indexes, kernel direction,
and cycle rules with a **zero-entry known-violation baseline**.

**Recommendation:** keep one NestJS deployable and continue using the modular
monolith as the temporary trunk. Do not begin the seven-deployable Turborepo proposed in
FUTURE_STATE.md yet. That proposal adds distributed calls, deployment topology,
and database-role complexity while this backend still has a single deployable,
a shared data model, and unresolved in-process ownership. It can remain a later
extraction option once the modular-monolith target below is proven.

**Architecture depth:** Level 2 for most modules; Level 3 only for concrete
project/hierarchy invariants; Level 4 only for existing outbox-backed work.

## Evidence

| Area | Observed evidence | Assessment |
| --- | --- | --- |
| Runtime | TypeScript, NestJS 11, npm, Supabase/pg, single src/main.ts entry point | Good modular-monolith foundation. |
| Composition | AppModule imports 19 business modules | Good top-level composition root. |
| Boundary policy | .dependency-cruiser.cjs forbids deep module imports, kernel-to-feature imports, and cycles | Correct policy. |
| Boundary compliance | 0 dependency violations; 0 known exceptions | Enforced locally. |
| Primary hotspot | projects.service.ts: 4,548 lines; full projects module: 9,734 production lines | Extract workflows within the module. |
| Layer accuracy | notifications/domain was application orchestration | Moved to notifications/application. |
| Shared persistence | PersistenceModule was a mixed repository bucket | Dissolved; adapters now live with owners. |
| Tests | 97 spec files and two E2E test files | Good unit base; add focused integration/contract coverage while migrating. |

The local architecture checker now reports no boundary or cycle violations.

## Present state

    HTTP controller
      -> feature service
           -> feature repository / external client
      -> public feature index / application contract
           -> feature-owned repository or external adapter
      -> kernel technical infrastructure

Every feature now exposes an index.ts. Repositories, controllers, provider
clients, and internal DTOs stay private; Nest composition files may import
concrete module classes to avoid barrel-induced cycles.

### Current architecture tree

This is the complete architecture-relevant tree (generated outputs, .git, and
dependencies excluded).

    alphaci-enterprise-be/
    ├── docs/architecture/
    │   ├── BACKEND_ARCHITECTURE_ALIGNMENT_REVIEW.md
    │   ├── FUTURE_STATE.md                     # existing proposed service split
    │   └── ON_PREM_TOPOLOGY.md
    ├── scripts/
    ├── src/
    │   ├── main.ts
    │   ├── app.module.ts                       # application composition root
    │   ├── common/{config,filters,guards,interfaces,middleware}
    │   ├── config/
    │   ├── database/seeds/
    │   ├── health/
    │   ├── kernel/README.md                    # intended kernel; currently a skeleton
    │   ├── supabase/
    │   ├── scripts/
    │   ├── types/
    │   └── modules/
    │       ├── admin/                          # controller, service, repositories, guards, DTOs
    │       ├── audit/                          # service, repository, module
    │       ├── auth/                           # controller, service, module
    │       ├── capabilities/                   # controller, module
    │       ├── catalog/                        # controller, service, DTOs
    │       ├── ci/                             # controller, services, repositories, DTOs
    │       ├── deployments/                    # deployment API, application, repos, provider adapters, index.ts
    │       ├── existing-repos/                 # controller, service, DTOs
    │       ├── feedback/                       # controller, service, repository, DTO
    │       ├── github/                         # controllers, services, repository, worker, DTOs
    │       ├── hierarchy/
    │       │   ├── {assignments,config-broker,delivery-projects,github-sync}
    │       │   ├── {groups,project-link,repositories,systems,dto}
    │       │   └── hierarchy.module.ts
    │       ├── notifications/{api,application,infra,index.ts,notifications.module.ts}
    │       ├── projects/                       # large service and focused project services/repositories/DTOs
    │       ├── subscription/                   # controller, service, DTO
    │       ├── usage/                          # controller, service
    │       ├── workflows/                      # controller, service, builder, DTO
    │       └── workspaces/                     # controller, services, repository
    ├── supabase/{migrations,rollbacks}         # 60 migrations
    ├── tests/{e2e,integration,performance,unit}
    ├── .dependency-cruiser.cjs
    ├── .dependency-cruiser-known-violations.json
    ├── package.json
    └── tsconfig.json

## Required changes

1. **Make module APIs real — high impact, high confidence.**
   The known baseline contains 190 deep imports. Projects reaches
   env-provisioning repositories, provider registry, encryption service, DTOs,
   and types; hierarchy and env-provisioning each register ProjectsRepository
   directly. Give every module one index.ts that exports its Nest module,
   selected application facade/token, and cross-module contract types. Do not
   export controllers, repositories, vendor clients, or HTTP DTOs. Migrate
   consumers one at a time and delete their baseline entries.

2. **Break the projects/env-provisioning cycle — high impact, high confidence.**
   The recorded cycle is between projects/projects.service.ts and
   env-provisioning/project-deployment-provisioning.service.ts; the provisioning
   service imports project-owned request/result types. Move those contracts to
   the env-provisioning public API. Projects consumes its exported facade;
   env-provisioning must not import projects.

3. **Move database concerns to the kernel and dissolve persistence — high
   impact, high confidence.**
   Move the database client, SSL configuration, transaction support, and
   connection configuration to kernel/db. Move user/OAuth state repositories
   to auth; subscription storage to subscription; workflow history to workflows;
   CI tokens to CI. Keep an outbox in kernel/events only if it is genuinely
   cross-module. Consumers use a facade or focused port, never another module's
   repository.

4. **Extract project workflows within the projects module — high impact, high
   confidence.**
   Divide ProjectsService by coherent workflow: lifecycle, dashboard/snapshot
   queries, deployments, previews, workflow changes, and drift repair. Keep
   them inside projects; use ports only at actual provider or cross-module seams.

5. **Correct the notifications layer — medium impact, high confidence.**
   Rename notifications/domain to application. Add a domain folder only for a
   pure business policy that actually appears.

6. **Invert shared guard dependencies — medium impact, high confidence.**
   Move shared guards to kernel/auth. They should depend on a small
   SessionUserLookup contract defined by the kernel; auth owns and wires its
   adapter. The kernel must never import an application feature.

## Future state

    HTTP / transport
      -> module api
      -> module application service or workflow
      -> optional pure domain policy (only for a real invariant)
      -> module-owned repository or external adapter

    module-to-module calls
      -> owner's index.ts public facade + contract types

    kernel
      -> config, db, HTTP concerns, auth contracts, events, shared types
      -> never imports modules

### Full target source tree

The target remains a modular monolith. A module receives a domain directory
only when it has an invariant that is independent of Nest and infrastructure.

    src/
    ├── main.ts
    ├── app.module.ts                           # only top-level composition
    ├── kernel/
    │   ├── auth/{session-auth.guard.ts,subscription.guard.ts,session-user-lookup.contract.ts}
    │   ├── config/{app.config.ts,env.validation.ts,security.config.ts}
    │   ├── db/{database.module.ts,database.service.ts,postgres-ssl.config.ts}
    │   ├── events/{outbox.repository.ts,outbox-worker.ts}
    │   ├── http/{all-exceptions.filter.ts,correlation-id.middleware.ts}
    │   └── types/
    ├── health/
    ├── modules/
    │   ├── admin/{api,application,infra,admin.module.ts,index.ts}
    │   ├── audit/{application,infra,audit.module.ts,index.ts}
    │   ├── auth/
    │   │   ├── api/
    │   │   ├── application/{auth.service.ts,session-user-lookup.adapter.ts,ports}
    │   │   ├── infra/                         # users and OAuth-state repositories
    │   │   ├── auth.module.ts
    │   │   └── index.ts
    │   ├── capabilities/{api,application,capabilities.module.ts,index.ts}
    │   ├── catalog/{api,application,infra,catalog.module.ts,index.ts}
    │   ├── ci/{api,application,infra,ci.module.ts,index.ts}
    │   ├── env-provisioning/
    │   │   ├── api/
    │   │   ├── application/{deployment-provisioning.facade.ts,deployment-targets.service.ts,env-vars.service.ts,provider-connections.service.ts,ports}
    │   │   ├── domain/                        # provider-neutral rules only, if needed
    │   │   ├── infra/{repositories,provider-clients}
    │   │   ├── env-provisioning.module.ts
    │   │   └── index.ts                       # facade and contracts only
    │   ├── existing-repos/{api,application,existing-repos.module.ts,index.ts}
    │   ├── feedback/{api,application,infra,feedback.module.ts,index.ts}
    │   ├── github/{api,application,infra,workers,github.module.ts,index.ts}
    │   ├── hierarchy/
    │   │   ├── api/
    │   │   ├── application/{assignments,config-broker,delivery-projects,github-sync,groups,project-link,repositories,systems}
    │   │   ├── domain/                        # membership/lifecycle policies if required
    │   │   ├── infra/
    │   │   ├── hierarchy.module.ts
    │   │   └── index.ts
    │   ├── notifications/{api,application,infra,notifications.module.ts,index.ts}
    │   ├── projects/
    │   │   ├── api/
    │   │   ├── application/{project-lifecycle.service.ts,project-dashboard.service.ts,project-deployments.service.ts,project-previews.service.ts,project-workflows.service.ts,project-drift.service.ts,ports}
    │   │   ├── domain/                        # project status/lifecycle invariants only
    │   │   ├── infra/{repositories,clients}
    │   │   ├── projects.module.ts
    │   │   └── index.ts                       # facade and public contracts
    │   ├── subscription/{api,application,infra,subscription.module.ts,index.ts}
    │   ├── usage/{api,application,infra,usage.module.ts,index.ts}
    │   ├── workflows/{api,application,domain,infra,workflows.module.ts,index.ts}
    │   └── workspaces/{api,application,domain,infra,workspaces.module.ts,index.ts}
    ├── scripts/
    └── types/

Modules/database and modules/persistence are deliberately absent from the
target tree. Their responsibilities move to kernel/db, kernel/events, and the
owning feature modules.

## Migration order and verification

    1. Make boundaries:new pass locally with an empty baseline.
2. Move database and guard contracts into the kernel, with module boot tests.
3. Add each module's deliberate public index.ts; migrate simple one-way
   consumers and shrink the baseline.
4. Move provisioning contracts to env-provisioning and remove the cycle.
5. Move repositories out of persistence, one owner at a time.
6. Extract one projects workflow at a time while retaining HTTP contracts and
   its existing tests.
7. Reduce the known-violations baseline to zero before reassessing service
   extraction.

Local verification on `codex/modular-monolith-boundaries`, re-run and
confirmed on 2026-08-25 with a restored `node_modules` (see Verification
notes below):

- TypeScript typecheck (`npm run typecheck`): passed, 0 errors.
- Jest (`npm test -- --runInBand`): 99 suites / 1,150 tests passed.
- Dependency-cruiser with baseline (`npm run boundaries`): passed
  (0 violations, 281 modules, 1,129 dependencies).
- Dependency-cruiser without baseline (`npm run boundaries:new`): passed
  (0 violations) -- the known-violations file is genuinely `[]`, not merely
  ignored.
- Nest production build (`npm run build`): passed.
- E2E Jest (`npm run test:e2e`): passed (2/2 tests).
- Repository-wide ESLint (`npm run lint`): 751 errors, all
  `prettier/prettier` CRLF-insertion findings. Confirmed environmental, not a
  code-quality regression: this machine has `core.autocrlf=true`, the repo
  has no `.gitattributes` to pin line endings, and Prettier's default
  `endOfLine: "lf"` then flags the checkout. `git show HEAD:<file>` proves
  the committed blobs are pure LF. This affects touched and untouched files
  alike and predates this plan; add a `.gitattributes` with
  `* text=auto eol=lf` to close it permanently. GitHub CI is intentionally
  not used because Actions minutes are exhausted.

**Verification notes:** the repo's package manager is npm
(`package-lock.json` is the committed lockfile). An untracked
`pnpm-workspace.yaml` and `.pnpm-store/` in the working tree are stray
artifacts from an unrelated pnpm invocation and are not part of this plan --
do not run `pnpm install` against this repository; use `npm ci`.
