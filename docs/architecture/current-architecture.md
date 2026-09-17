---
type: "Architecture Reference"
title: "Current AlphaCI backend architecture"
description: "Current source, deployment, context, provider, database, and event composition for the AlphaCI backend."
tags: [architecture, current-state, modular-monolith]
status: stable
sources:
  - id: application-root
    resource: "src/app.module.ts"
    title: "Application composition root"
  - id: http-bootstrap
    resource: "src/main.ts"
    title: "HTTP bootstrap and middleware composition"
  - id: context-source
    resource: "src/modules"
    title: "Bounded-context source tree"
  - id: migration-source
    resource: "supabase/migrations"
    title: "Owned migration tree"
---
# Current AlphaCI backend architecture

The backend is one NestJS deployable with an Express HTTP adapter, a shared technical kernel, six bounded-context roots, PostgreSQL/Supabase persistence, and Runtime-owned provider plugins. The [constitution](/constitution.md) defines the invariants that keep this composition coherent.

## Runtime tree

```text
src/
├── app.module.ts                         # application composition root
├── main.ts                               # Express/Nest middleware and listener
├── app.controller.ts / app.service.ts
├── health/                               # liveness and readiness endpoints
│   ├── health.controller.ts
│   ├── health.module.ts
│   └── health.service.ts
├── kernel/                               # technical shared infrastructure
│   ├── auth/                             # session lookup and guards
│   ├── config/                           # environment and security config
│   ├── db/                               # database and Supabase access
│   ├── events/                           # outbox persistence and dispatch
│   ├── http/                             # middleware and exception filters
│   └── ports/                             # focused dependency-inversion ports
├── packs/                                 # profile-owned Enterprise implementation packs
│   └── enterprise/                        # client-policy parser, registry, and factory
└── modules/
    ├── identity-access/                  # auth, admin, capabilities, hierarchy
    ├── projects/                         # projects, catalog, workflows, repos
    ├── pipelines/                        # GitHub integration and CI reporting
    ├── runtime/                          # targets, env, domains, providers
    ├── billing/                          # subscriptions, usage, quotas
    └── platform-ops/                     # audit, notifications, feedback
```

Each context has a `<context>.module.ts` composition root and an `index.ts` public API. Feature Nest modules remain private composition details behind those roots. The full ownership and source count are in the [generated context map](/architecture/context-map.generated.md).

## HTTP composition

`src/main.ts` creates the Express application, applies proxy trust, session storage, security headers, JSON and URL-encoded body parsers, CORS, validation, exception handling, the global `api/v1` prefix, optional Swagger, and the listener. `AppModule` adds configuration validation, throttling, database access, health, and the six context roots.

## Technical kernel

The kernel owns technical concerns shared by contexts: environment/configuration, database clients, session/auth infrastructure, HTTP cross-cutting behavior, outbox persistence, topic dispatch, and focused ports. Composition ports and generic policy application remain shared here, while profile-owned policy parsing, registries, and factories live under `src/packs/<profile>` and are loaded through a profile-keyed seam. The kernel does not own business aggregates, provider policy, or context persistence.

## Runtime providers

Runtime contains generic registries and provider implementations under `src/modules/runtime/infrastructure/providers/`. A validated `RuntimeProviderPack` groups each provider descriptor with its applicable policy, runtime client, workflow fragment, and CI secret installer. The current registered provider IDs are `gcp`, `render`, and `vercel`; GCP is currently catalog/provisioning-only while Render and Vercel expose the environment client surface. The [provider map](/architecture/provider-map.generated.md) records composition modules, responsibilities, slots, and configuration gating.

## Persistence and migrations

The migration tree is grouped by the same six ownership boundaries:

```text
supabase/migrations/
├── identity-access/
├── projects/
├── pipelines/
├── runtime/
├── billing/
└── platform-ops/
```

`db:apply:all --dry-run` discovers all owner directories and sorts timestamp-prefixed migration names globally, preserving replay order. Exact current owners and transition allowances are in the [schema ownership map](/architecture/schema-ownership.generated.md).

## Events

`platform.outbox_events` is the current asynchronous work queue. The kernel stores registered topics and dispatches them to one handler per topic. `platform-ops` handles audit and notification topics; `identity-access` handles hierarchy assignment synchronization. The Render cron runs the compiled `scripts/process-outbox.cjs` entrypoint, which claims rows with short leases before invoking handlers. The relay rejects a lease that is not longer than its handler timeout. See the [event map](/architecture/events-map.generated.md).

## API surface

The current compiled API route inventory contains 145 routes under `/api/v1`. The [route map](/architecture/route-map.generated.md) is generated from the checked-in route reference and is protected by the route inventory test.

## Verification

The local architecture loop is documented in the [verification runbook](/runbooks/runbook-local-verification.md). The [architecture check map](/architecture/architecture-checks.generated.md) records measured source metrics and points to the authoritative executable gates.
