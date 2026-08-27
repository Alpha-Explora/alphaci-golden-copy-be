# Architecture remediation evidence

**Date:** 2026-08-27
**Trunk:** `codex/architecture-remediation-trunk`
**Worktree:** `C:\Users\anton\Codes\Alpha Explora\AlphaCi Enterprise\worktrees\alphaci-enterprise-be\merry-prism\alphaci-enterprise-be`
**Starting checkpoint:** `5b703e9025208e686201460e489a07417f1bbba4`
**Scope:** close the follow-up review findings without changing public API,
business state-machine semantics, provider compatibility values, or migration
replay order.

This file is an evidence ledger, not a claim that the monolith has already
become independently deployable microservices.

## 1. Outbox ownership and guarantees

- Active table: `platform.outbox_events`, defined by
  `supabase/migrations/identity-access/20260606_domain_schema_bootstrap.sql`.
- Active acknowledgement columns: `status`, `published_at`, and `updated_at`.
  The historical `public.outbox_events.processed_at` column is only used by
  replay/backfill/rollback SQL and is not referenced by the active relay.
- Producers use `OutboxRepository.publishInTransaction()` when the event is a
  critical part of a business mutation. Hierarchy assignment creation now
  couples the assignment row, pending GitHub-sync row, and grant event on one
  PostgreSQL transaction; revoke transitions retain the same property.
- Audit and notification events are explicitly best-effort post-commit
  observability writes. They are not advertised as transactional business
  events.
- One dispatcher owns the four registered topics. The hierarchy handler owns
  grant/revoke; `platform-ops` owns audit/notification.
- One scheduled deployment owner exists: Render cron
  `alphaci-outbox-relay`, invoking `node scripts/process-outbox.cjs` once per
  minute. The runner boots the application context and delegates to the same
  in-process relay used by the application.
- `pg_try_advisory_lock(hashtext('alphaci_platform_outbox_relay'))` prevents
  concurrent relay instances from processing the same batch. Delivery remains
  at-least-once; handlers must be repeat-safe.
- Legacy pending topics from the removed Kafka-era producers are quarantined by
  `20260827000000_quarantine_unowned_outbox_topics.sql`; new code rejects topics
  absent from the kernel registry.

## 2. Boundary and schema gates

The verification commands for this trunk are:

```text
npm run boundaries
npm run check:application-boundaries
npm run check:provider-encapsulation
npm run check:schema-ownership
npm run report:architecture-metrics -- --json
```

Dependency-cruiser is the authoritative import graph. The readable metrics
scanner is alias-aware and reports trend counts; it is not used as an
extraction proof. The schema gate scans migration SQL and repository/source
inline SQL, with exact file-and-table transition allowances rather than whole
file exemptions.

The latest alias-aware production-import measurement is:

| Context | Production files | Cross-context imports | Directional pairs |
|---|---:|---:|---:|
| `billing` | 21 | 1 | 1 |
| `identity-access` | 103 | 21 | 5 |
| `pipelines` | 37 | 1 | 1 |
| `platform-ops` | 26 | 0 | 0 |
| `projects` | 86 | 76 | 5 |
| `runtime` | 116 | 16 | 4 |
| **Total** | **389** | **115** | **16** |

The remaining imports are documented transition/composition seams. In
particular, runtime has three inbound context pairs and four outbound pairs;
the six-directory count is not presented as extraction readiness.

## 3. Regression and boot evidence

- Current route reference: 145 compiled Nest routes.
- `docs/architecture/route-inventory.manifest.json` records the current and
  post-consolidation reference SHA-256:
  `d11dcda02cd737f38612b0b19f932b8e30d4b992d8c011d1a61e77415ddbf23a`.
- A pre-consolidation route inventory and pre-Task-5 contract snapshots were
  not captured, so this repository cannot prove retroactive equality. The
  route and contract files are post-change references for future drift checks.
- `tests/architecture/contract-snapshots.spec.ts` protects current provider
  discovery and staged workflow metadata/YAML shape.
- `tests/architecture/app-module.boot.spec.ts` constructs the complete Nest
  application context with test configuration.
- `tests/architecture/http-boot.spec.ts` boots the real Express adapter and
  calls the health route. With no database configured, the expected readiness
  result is a structured 503 with status, path, and correlation id; a configured
  database may return the normal 200 readiness response.
- `tests/architecture/provider-plugin.acceptance.spec.ts` composes a fake
  provider through metadata, runtime client, workflow fragment, CI installer,
  and the staged workflow builder without changing the builder.
- `tests/integration/database.integration.spec.ts` checks the live Postgres
  outbox schema when `SUPABASE_DB_URL` is present. Without that environment
  variable it is intentionally skipped; migration dry-run and SQL gates do not
  pretend to prove live connectivity.

## 4. Projects and provider posture

- `ProjectsService` is a compatibility facade (504 lines on this trunk).
  Dashboard, workflow, lifecycle, reconciliation, and provisioning use cases
  are in focused application services; the provisioning slice remains the
  largest focused service (1,865 lines) because it preserves the existing
  setup sequence.
- Runtime provider metadata adapters, clients, workflow fragments, workflow
  target expansion, descriptor-driven slot policy, and CI secret installers
  are registry-driven and provider ids are open at the generic seams. Render/
  Vercel token/scope selection, target strategy identifiers, secret naming,
  storage fields, legacy DTO fields, and the parallel GCP runtime remain
  compatibility code inside Runtime.
- Provider compatibility code is deliberately not moved into billing,
  identity-access, pipelines, or projects. No provider creates a seventh
  bounded context.

## 5. Rollback and extraction decisions

- The remediation started from checkpoint `5b703e9` on the named trunk. The
  final remediation change is a normal commit that can be reverted with
  `git revert`; no reset, force-push, branch deletion, or worktree cleanup is
  needed.
- Rollback independence across separate PRs is a review/process property, not
  something this single worktree can prove automatically.
- Task 11 remains closed. No independent scaling requirement, independent
  deployment cadence, or regulatory-isolation trigger has been supplied.
  Extraction therefore remains a future composition/transport decision, not a
  deliverable of this consolidation.

## 6. Known evidence limits

1. Historical pre-change route and contract baselines are unavailable.
2. The live Postgres integration result depends on `SUPABASE_DB_URL` and is
   reported separately from local tests.
3. The current monolith still has synchronous cross-context imports and
   provider compatibility seams; it is not claimed to be service-extraction
   ready by directory count alone.
4. A production rollback rehearsal and external scheduler execution require
   deployment credentials/infrastructure and are not simulated locally.

## 7. Final verification run

The final local verification on this trunk completed with:

- TypeScript typecheck: passed.
- Nest production build: passed; compiled `#modules/runtime/index.js` and
  `#kernel/events/outbox.repository.js` resolution smoke: passed.
- Changed-file ESLint: passed with zero warnings or errors.
- Jest regression suite: 130 passed suites, 1 intentionally skipped suite;
  1,242 passed tests, 2 intentionally skipped tests; 2 snapshots passed.
- Dependency-cruiser: passed (`357` modules, `1,434` dependencies cruised).
- Application-boundary, provider-encapsulation, and schema-ownership gates:
  passed. The schema gate inspected 63 migrations and inline SQL.
- Architecture metrics: 389 production files, 115 cross-context imports, and
  16 directional context pairs.
- Migration replay dry-run: passed; all 63 owner-folder migrations were
  discovered in global timestamp order and nothing was applied.
- HTTP route inventory: 145 routes; the route and current-reference hashes
  match the checked-in manifest.
- Postgres integration: conditional; skipped when `SUPABASE_DB_URL` is not
  configured. The local suite does not claim live database connectivity.

Repository-wide lint remains a separate baseline check: changed files are
clean, while pre-existing findings in untouched files are not part of this
remediation slice and are not represented as a newly introduced failure.
