# Architecture remediation evidence

**Date:** 2026-08-28
**Evidence type:** repository verification record
**Scope:** close the architecture findings without changing public
API, business state-machine semantics, provider compatibility values, or
migration replay order.

This is an evidence ledger for the six-context modular monolith. It does not
claim that the application has become independently deployable microservices.
Microservice extraction is a future-only option and is outside the current
deployment model.

## 1. Outbox ownership and guarantees

- The active table is `platform.outbox_events`, defined by
  `supabase/migrations/identity-access/20260606_domain_schema_bootstrap.sql`.
- Active acknowledgement uses `status`, `published_at`, and `updated_at`.
  The active relay does not reference the historical `processed_at` name.
- `supabase/migrations/platform-ops/20260828000000_outbox_reliability.sql`
  adds retry/error/quarantine state, makes `available_at` nullable for
  terminal rows, and adds pending/quarantine indexes. Its rollback is recorded
  at `supabase/rollbacks/20260828000000_outbox_reliability_down.sql`.
- Critical hierarchy assignment grant/revoke mutations use
  `OutboxRepository.publishInTransaction()` with the assignment and sync-row
  changes on the same PostgreSQL transaction. Audit and notification writes
  remain explicitly best-effort post-commit observability writes, preserving
  their prior non-critical behavior.
- One `OutboxDispatcher` owns four registered topics:
  `platform.audit.recorded`, `platform.notification.requested`,
  `hierarchy.repository_assignment.grant`, and
  `hierarchy.repository_assignment.revoke`. `platform-ops` owns the first two;
  `identity-access` owns the hierarchy handler.
- One scheduled deployment owner exists: the Render cron
  `alphaci-outbox-relay`, invoking `node scripts/process-outbox.cjs` once per
  minute. The runner boots the normal application context and invokes the same
  in-process relay used by the application.
- `pg_try_advisory_lock(hashtext('alphaci_platform_outbox_relay'))` prevents
  concurrent relay instances from processing the same batch. Delivery remains
  at-least-once, so handlers must be idempotent.
- Legacy pending topics from the removed Kafka-era producers are quarantined by
  `20260827000000_quarantine_unowned_outbox_topics.sql`; new code rejects
  topics absent from the kernel registry.

## 2. Boundary, provider, and schema gates

The checked gates are:

```text
npm run boundaries
npm run check:application-boundaries
npm run check:provider-encapsulation
npm run check:schema-ownership
npm run report:architecture-metrics -- --json
npm run db:apply:all -- --dry-run
```

Dependency-cruiser is the authoritative import graph. The readable metrics
scanner is alias-aware and reports trends; it is not used as an extraction
proof. The schema gate scans migration SQL and repository/source inline SQL,
with exact file-and-table transition allowances rather than whole-file
exemptions.

Latest alias-aware metrics:

| Context | TS files | Test files | Production files | Application files | Cross-context | Composition | Contract | Application edge | Directional pairs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `billing` | 21 | 5 | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| `identity-access` | 103 | 15 | 88 | 0 | 8 | 8 | 0 | 0 | 5 |
| `pipelines` | 37 | 9 | 28 | 0 | 1 | 1 | 0 | 0 | 1 |
| `platform-ops` | 27 | 3 | 24 | 3 | 0 | 0 | 0 | 0 | 0 |
| `projects` | 90 | 23 | 67 | 37 | 15 | 15 | 0 | 0 | 5 |
| `runtime` | 123 | 43 | 80 | 16 | 8 | 8 | 0 | 0 | 4 |
| **Total** | **401** | **98** | **303** | **56** | **32** | **32** | **0** | **0** | **15** |

All remaining cross-context imports are explicit Nest composition wiring. No
production contract/application import or actionable cross-context edge is
reported. The six-directory count is therefore not presented as extraction
readiness.

Additional gate results:

- Dependency-cruiser: 382 modules, 1,544 dependencies cruised, zero violations.
- Application-boundary check: zero violations.
- Provider-encapsulation check: passed.
- Schema-ownership check: zero migration violations and zero source-SQL
  violations.
- Migration replay dry-run: 64 migrations discovered in global timestamp
  order; nothing was applied.

Provider-specific policies, metadata, clients, workflow fragments, target
expansion, and CI secret installers are registered inside Runtime. Provider
ids and generic strategy seams are open at the plugin boundary; Render/Vercel
compatibility fields remain Runtime-owned because they are part of the
existing API/database contract. Projects intentionally retains the legacy
`deploy_render` / `deploy_vercel` CI stage labels and the provider-host URL
allowlist for compatibility and security; neither is provider orchestration.

## 3. Regression, route, and boot evidence

- Current compiled route inventory: 145 routes.
- The pre-consolidation route inventory is now available from source commit
  `b175938` at `route-inventory.pre-consolidation.txt`.
- Pre-consolidation and current inventories are byte-for-byte equal, both with
  SHA-256
  `d11dcda02cd737f38612b0b19f932b8e30d4b992d8c011d1a61e77415ddbf23a`.
- A pre-consolidation contract snapshot is not available: the source commit
  did not contain one. Current snapshots therefore protect future drift but do
  not make a retroactive contract comparison possible.
- `tests/architecture/app-module.boot.spec.ts` constructs the complete Nest
  application context with test configuration.
- `tests/architecture/http-boot.spec.ts` boots the real Express adapter and
  calls the health route. With no database configured, the expected readiness
  result is a structured 503; a configured database may return normal 200
  readiness.
- `tests/architecture/provider-plugin.acceptance.spec.ts` composes a fake
  provider through metadata, policy, runtime client, workflow fragment, CI
  installer, and the staged workflow builder.
- `tests/integration/database.integration.spec.ts` is a live PostgreSQL
  integration test when `SUPABASE_DB_URL` is supplied. No database URL is
  configured in the verification environment, so the live test is intentionally skipped; static SQL
  checks and migration dry-run do not pretend to prove live connectivity.

## 4. Projects and provider posture

`ProjectsService` is a compatibility facade at 537 lines. The former
provisioning hotspot is split by actual use case:

| Slice | Lines |
|---|---:|
| Provisioning dispatcher | 215 |
| Shared provisioning mechanics | 535 |
| Single-repository provisioner | 466 |
| Microservices-shaped project provisioner | 340 |
| Multi-repository provisioner | 460 |

The `microservices` label in the table describes a project repository shape
handled by the existing product workflow; it is not microservice extraction.

Dashboard, workflow, lifecycle, reconciliation, and provisioning behavior is
owned by focused application services. Remaining facade methods are
compatibility forwarding, not a second implementation.

## 5. Build, lint, and operational evidence

- `npm run typecheck`: passed.
- `npm run build`: passed using the repository's direct TypeScript build
  (`tsc -p tsconfig.build.json`). This avoids a reproducible Nest CLI path
  transformer failure with TypeScript 5.9 and the repository's `#kernel` /
  `#modules` aliases; it does not change the emitted application behavior.
- Full ESLint: 483 files, zero errors, zero warnings.
- Jest: 130 passed suites, one intentionally skipped suite; 1,247 passed tests,
  two intentionally skipped tests; two snapshots passed.
- The Render cron and Dockerfile wiring are checked into the repository and
  covered by `tests/architecture/outbox-scheduler.spec.ts`. Actual execution
  of the deployed cron still requires the deployment environment.
- No local production rollback rehearsal or external scheduler execution was
  performed in the verification environment.

## 6. Evidence limits

1. A pre-consolidation contract snapshot did not exist in the source commit;
   the route baseline is available, but contract equality cannot be proven
   retroactively.
2. `SUPABASE_DB_URL` is not configured in this environment. The live Postgres
   integration test and transaction assertions are available but were not
   executed here.
3. The Render cron is statically wired and guarded by an operational test;
   deployed execution and rollback rehearsal require deployment credentials.
4. Runtime retains historical provider-specific compatibility fields and the
   Projects context retains legacy CI stage labels and a provider-host URL
   allowlist. The monolith also retains synchronous composition imports. These
   are intentional current-state constraints, not evidence of a completed
   service extraction.

## 7. Future-only extraction posture

No independent scaling requirement, independent deployment cadence, or
regulatory-isolation trigger is part of the current system requirements.
Microservice extraction remains a future composition/transport decision, not a
current deliverable. Reopen it only after an operational trigger is documented
and the measured application edges justify the added deployment and data
ownership complexity.
