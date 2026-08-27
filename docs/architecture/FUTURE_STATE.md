# AlphaCI Enterprise Backend — current and future state

**Status:** current target adopted; microservice extraction is future-only.
This document describes the six-context modular monolith on the remediation
trunk and the compatible shape to use if a real extraction trigger appears.

## Decision

The backend stays one NestJS deployable. The former 17 feature modules are
grouped into six bounded contexts because those are the product ownership lines:

1. `identity-access` — authentication, administration, capabilities,
   workspaces, hierarchy, and repository access policy.
2. `projects` — project lifecycle, catalog, workflows, existing repositories,
   and project read models.
3. `pipelines` — GitHub integration, CI tokens, and CI report ingestion.
4. `runtime` — deployment targets, environment variables, domains, provider
   connections, provider clients, and deployment history.
5. `billing` — subscriptions, usage, and quota policy.
6. `platform-ops` — audit, notifications, feedback, and the in-process outbox
   relay.

Providers are plugins inside `runtime`, not bounded contexts. SaaS, on-prem,
and other deployment modes are configuration/composition choices, not copies of
the domain modules.

## Current state — implemented tree

```text
src/
├── app.module.ts                         # composition root; six context roots
├── main.ts                               # HTTP/Express composition and bootstrap
├── app.controller.ts / app.service.ts
├── health/                                # liveness/readiness endpoint
│   ├── health.controller.ts
│   ├── health.module.ts
│   └── health.service.ts
├── kernel/                                # technical shared kernel only
│   ├── auth/                              # session lookup + auth guards
│   ├── config/                            # env validation and app config
│   ├── db/                                # DatabaseService, Supabase, SSL
│   ├── events/                            # outbox, topic registry, dispatcher
│   ├── http/                              # filters and middleware
│   └── ports/                             # cycle-breaking serialisable ports
└── modules/
    ├── identity-access/                   # bounded-context root
    │   ├── auth/
    │   ├── admin/
    │   ├── capabilities/
    │   ├── workspaces/
    │   ├── hierarchy/
    │   │   ├── groups/
    │   │   ├── systems/
    │   │   ├── delivery-projects/
    │   │   ├── repositories/
    │   │   ├── assignments/
    │   │   ├── github-sync/
    │   │   ├── config-broker/
    │   │   └── project-link/
    │   ├── identity-access.module.ts
    │   └── index.ts
    ├── projects/                          # bounded-context root
    │   ├── api/                           # project controllers
    │   ├── application/
    │   │   ├── catalog/
    │   │   ├── dashboard/
    │   │   ├── drift/
    │   │   ├── existing-repos/
    │   │   ├── lifecycle/                 # provisioning, lifecycle, reconcile
    │   │   └── workflows/                 # settings, files, staged builders
    │   ├── contracts/
    │   ├── *.repository.ts                # project-owned persistence (flat legacy seam)
    │   ├── projects.module.ts
    │   └── index.ts
    ├── pipelines/                         # bounded-context root
    │   ├── github/
    │   ├── ci/
    │   ├── pipelines.module.ts
    │   └── index.ts
    ├── runtime/                           # bounded-context root
    │   ├── api/
    │   ├── application/
    │   │   └── ports/                     # only justified provider seams
    │   ├── core/                          # contracts, registries, policies
    │   ├── domain/
    │   ├── infrastructure/
    │   │   ├── repositories/
    │   │   └── providers/
    │   │       ├── core/                  # generic registries and helpers
    │   │       ├── gcp/
    │   │       ├── render/
    │   │       ├── vercel/
    │   │       └── legacy/                # compatibility composition adapter
    │   ├── runtime.module.ts
    │   └── index.ts
    ├── billing/                           # bounded-context root
    │   ├── subscription/
    │   ├── usage/
    │   ├── billing.module.ts
    │   └── index.ts
    └── platform-ops/                      # bounded-context root
        ├── api/
        ├── application/                   # audit, notifications, relay
        ├── feedback/
        ├── audit/
        ├── notifications/
        ├── platform-ops.module.ts
        └── index.ts
```

The database migration tree mirrors the six owners:

```text
supabase/migrations/
├── identity-access/
├── projects/
├── pipelines/
├── runtime/
├── billing/
└── platform-ops/
```

`db:apply:all --dry-run` globally sorts migration basenames, so moving a file
under an owner directory does not change replay order. Existing cross-schema
references are explicit transition entries in
`scripts/check-schema-ownership.cjs`; new references must obey
`docs/architecture/SCHEMA_OWNERSHIP.md`.

## Current boundary and delivery facts

- `AppModule` imports the six context roots, plus technical kernel/health
  modules; feature modules are composed behind those roots.
- Cross-context code uses public barrels, `contracts/`, or focused ports.
  Dependency-cruiser is the authoritative import graph and must remain at zero
  violations.
- The static metrics report counts aliased and relative production imports. It
  is descriptive, not a proof of extractability. The latest remediation
  measurement is recorded in `docs/architecture/REMEDIATION_EVIDENCE.md`.
- `platform.outbox_events` has one scheduled compiled runner,
  `scripts/process-outbox.cjs`, and one in-process `OutboxRelayService`. The
  relay filters to registered handler topics and uses PostgreSQL advisory
  locking. Delivery is at-least-once.
- Hierarchy grant/revoke state changes and their queue rows use the same
  transaction. Audit/notification events are deliberately best-effort
  post-commit observability writes, preserving their previous non-critical
  behavior; they are not advertised as transactionally coupled.
- `ProjectsService` is now a compatibility facade. Project provisioning,
  dashboard, workflow, lifecycle, and reconciliation implementations live in
  focused application services. Remaining facade methods and the large
  provisioning workflow are compatibility debt, not a second implementation.
- Render, Vercel, and GCP are provider plugins. Provider ids, metadata,
  clients, workflow fragments, and CI secret installers are registry-driven;
  provider-specific compatibility logic remains inside `runtime`.

## Deferred future option — microservice extraction

The following topology is a future reference only. It is not a current build
phase, implementation task, or deployment target.

If independent scaling, deployment cadence, or regulatory isolation becomes a
measured requirement, extract one context behind the seams already present:

```text
apps/
├── platform-api/          # current HTTP composition / gateway role
├── runtime-service/       # first candidate after edges are reduced behind ports
├── projects-service/
├── identity-access-service/
├── pipelines-service/
├── billing-service/
└── platform-ops-service/
libs/
├── contracts/             # versioned serialisable context contracts
├── events/                # topic registry, payload schemas, inbox/outbox
└── transport/             # HTTP/gRPC adapters selected at composition time
```

The extraction changes are intentionally limited to composition, but only after
the measured synchronous edges that carry application behavior are reduced to
serialisable contracts and transport-swappable ports:

| Today | Future | Code that changes |
|---|---|---|
| local adapter bound to a context port | HTTP/gRPC client bound to the same port | module wiring after edge reduction |
| source `contracts/` imports | versioned shared package/generated client | package/build wiring |
| Postgres outbox + in-process relay | outbox relay to a broker only if needed | relay/operations |
| shared database schemas | split schema/role after ownership is proven | migrations/operations |

Application and domain logic should not change merely because transport changes.
Only reopen this future option when an operational trigger is documented:
independent scaling, independent deployment cadence, or regulatory isolation.
Architecture cleanliness alone is not a trigger, and this option is outside the
current consolidation plan.

## Explicit non-goals

- no gateway, internal JWT, broker, or six independent connection pools now;
- no database role/search-path redesign as part of this refactor;
- no new provider-specific top-level module;
- no claim that current synchronous edges or compatibility DTO/storage fields
  are already independently deployable.
