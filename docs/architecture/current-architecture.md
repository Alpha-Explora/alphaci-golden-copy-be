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
  - id: deployment-mode
    resource: "src/kernel/config/deployment-mode.ts"
    title: "Deployment mode and storage driver"
  - id: selfhost-compose
    resource: "deploy/selfhost/compose.yaml"
    title: "Self-hosted Compose appliance"
  - id: outbox-workers
    resource: "src/modules/platform-ops/application/outbox-relay.worker.ts"
    title: "In-process outbox relay worker"
---
# Current AlphaCI backend architecture

The backend is one NestJS deployable with an Express HTTP adapter, a shared technical kernel, six bounded-context roots, PostgreSQL persistence, and Runtime-owned provider plugins. It runs either as the managed service or as a self-hosted appliance on the customer's own server. The [constitution](/constitution.md) defines the invariants that keep this composition coherent.

## Runtime tree

```text
src/
├── app.module.ts                         # application composition root
├── main.ts                               # Express/Nest middleware and listener
├── app.controller.ts / app.service.ts
├── health/                               # liveness and readiness endpoints
├── cli/                                  # alphaci-ctl: init, admin-grant, doctor, host-enrollment
├── scripts/                              # compiled jobs: self-host migrations, repository reconciliation
├── kernel/                               # technical shared infrastructure
│   ├── auth/                             # session lookup and guards
│   ├── composition/                      # capability registry, manifests, resolver, guard
│   ├── config/                           # environment, deployment mode, and security config
│   ├── db/                               # PostgreSQL and Supabase access
│   ├── events/                           # outbox persistence and dispatch
│   ├── http/                             # middleware and exception filters
│   ├── ports/                            # focused dependency-inversion ports
│   └── rules/                            # pure authorization rules shared by contexts
├── packs/                                # profile-owned Enterprise implementation packs
│   └── enterprise/                       # client-policy parser, registry, and factory
└── modules/
    ├── identity-access/                  # auth, admin, capabilities, workspaces, hierarchy, directory
    ├── projects/                         # projects, environments, requirements, QA runs, workflows
    ├── pipelines/                        # GitHub integration and CI reporting
    ├── runtime/                          # targets, env, domains, providers, on-prem hosts, releases
    ├── billing/                          # subscriptions, usage, quotas
    └── platform-ops/                     # audit, notifications, feedback, outbox relay
```

Each context has a `<context>.module.ts` composition root and an `index.ts` public API. Feature Nest modules remain private composition details behind those roots. The full ownership and source count are in the [generated context map](/architecture/context-map.generated.md).

## HTTP composition

`src/main.ts` creates the Express application, applies proxy trust, session storage, security headers, JSON and URL-encoded body parsers, CORS, validation, exception handling, the global `api/v1` prefix, optional Swagger (`ENABLE_SWAGGER=true`), and the listener. Sessions use the in-memory store or PostgreSQL through `connect-pg-simple` when `SESSION_STORE_DRIVER=postgres`. `AppModule` adds configuration validation, throttling, database access, health, and the six context roots.

## Technical kernel

The kernel owns technical concerns shared by contexts: environment/configuration, database clients, session/auth infrastructure, capability composition, HTTP cross-cutting behavior, outbox persistence, topic dispatch, focused ports, and pure authorization rules used by two or more contexts. Composition ports and generic policy application remain shared here, while profile-owned policy parsing, registries, and factories live under `src/packs/<profile>` and are loaded through a profile-keyed seam. The kernel does not own business aggregates, provider policy, or context persistence. The [capability contract](/capabilities/capability-contract.md) describes composition configuration and resolution.

## Deployment modes

`ALPHACI_DEPLOYMENT_MODE` selects how the deployable runs. It is a deployment axis, separate from the edition.

| Mode | Value | Platform hosting | Database | QA screenshot bytes |
|---|---|---|---|---|
| Managed | `saas` (default when unset) | API and outbox cron on Render, frontend on Vercel | Supabase PostgreSQL | Supabase Storage when `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is set, otherwise PostgreSQL |
| Self-hosted | `selfhosted` | Docker Compose appliance on the customer's server | Plain PostgreSQL 16 in the appliance | PostgreSQL (`projects.qa_attachment_objects`) |

`STORAGE_DRIVER` (`postgres` or `supabase`) overrides the storage default. The self-hosted mode refuses `STORAGE_DRIVER=supabase` and requires `SESSION_STORE_DRIVER=postgres`, `DATABASE_URL`, and `PLATFORM_PUBLIC_URL`. An invalid value stops the boot.

The self-hosted appliance in `deploy/selfhost/` runs these Compose services: `db` (PostgreSQL 16), `migrate` (the ledgered migration runner, run to completion before the API starts), `api`, `web` (the frontend image, built once with `NEXT_PUBLIC_API_BASE_URL=/api/v1`), and `proxy` (Caddy, terminating HTTPS). Secrets are Compose secret files. `deploy/selfhost/alphaci-ctl` wraps the CLI (`init`, `admin-grant`, `doctor`, `host-enrollment`) and adds `registry-token` and `server-host`. The `alphaci-app-routes` timer writes Caddy routes for deployments on the AlphaCI server under `ONPREM_APPS_DOMAIN`. Customers keep github.com, GitHub-hosted runners, GHCR, and SonarCloud; generated CI calls the self-hosted API through its public HTTPS address. The [self-hosted install runbook](/runbooks/runbook-selfhost-install.md) is the operator procedure.

Release manifests for customer-hosted targets are signed by the generated `sign-release` job by default (`ALPHACI_RELEASE_SIGNER=runner`, Cloud KMS). With `ALPHACI_RELEASE_SIGNER=file`, the backend signs with a P-256 key file it holds (`ALPHACI_RELEASE_SIGNING_KEY_FILE`), and no signing job or signing secret reaches GitHub. The self-hosted appliance uses `file`. See the [release registry](/architecture/release-registry.md).

## Runtime providers

Runtime contains generic registries and provider implementations under `src/modules/runtime/infrastructure/providers/`. A validated `RuntimeProviderPack` groups each provider descriptor with its optional policy, runtime client, workflow fragment, CI secret installer, releaser, and deployment history source. The registered provider IDs are `gcp`, `onprem-compose`, `render`, and `vercel`.

- `render` and `vercel` expose the environment client surface, deployment history, and rollback (Render rollback and Vercel Instant Rollback).
- `onprem-compose` records targets and reads deployment history from the release registry; customer hosts pull signed releases by digest.
- `gcp` is catalog and provisioning only.

Each project environment chooses the provider for each slot; see [project environments](/architecture/project-environments.md). The [provider map](/architecture/provider-map.generated.md) records composition modules, responsibilities, slots, and configuration gating.

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

Both runners discover all owner directories and sort timestamp-prefixed migration names globally, preserving replay order. The managed deployment applies them with `npm run db:apply:all` (`--dry-run` lists the order). The self-hosted deployment applies them with `npm run db:migrate:selfhost` (the Compose `migrate` service), which takes an advisory lock, records each file with its checksum in `public.schema_migrations`, and stops when a recorded checksum differs from the file. Exact current owners and transition allowances are in the [schema ownership map](/architecture/schema-ownership.generated.md).

## Events

`platform.outbox_events` is the asynchronous work queue. The kernel stores registered topics and dispatches them to one handler per topic. `platform-ops` handles audit and notification topics; `identity-access` handles hierarchy assignment synchronization.

Three consumers claim rows with short leases and `FOR UPDATE SKIP LOCKED`, so they never deliver one row twice at the same time:

- `OutboxRelayWorker` runs inside the API every `OUTBOX_RELAY_INTERVAL_MS` (default 15 seconds; `0` turns it off). It delivers audit and notification topics, and hierarchy topics only when `HIERARCHY_GITHUB_SYNC_MODE=live`.
- `NotificationRelayWorker` runs inside the API every `NOTIFICATION_RELAY_INTERVAL_MS` (default 1 second, bounded 250 ms to 60 seconds) and delivers notification topics only. It is off when `OUTBOX_RELAY_INTERVAL_MS=0`.
- The compiled `scripts/process-outbox.cjs` entrypoint drains every registered topic. The managed deployment schedules it as a Render cron in `render.yaml`. It refuses to start unless `HIERARCHY_GITHUB_SYNC_MODE` is `live` or `stub`.

The relay rejects a lease that is not longer than its handler timeout. Users receive their notifications through a server-sent event stream that reads the notification table, so delivery does not depend on which instance relayed the event. See the [event map](/architecture/events-map.generated.md).

## API surface

The current compiled API route inventory contains 271 routes under `/api/v1`. The [route map](/architecture/route-map.generated.md) is generated from the checked-in route reference and is protected by the route inventory test.

## Verification

The local architecture loop is documented in the [verification runbook](/runbooks/runbook-local-verification.md). The [architecture check map](/architecture/architecture-checks.generated.md) records measured source metrics and points to the authoritative executable gates.
