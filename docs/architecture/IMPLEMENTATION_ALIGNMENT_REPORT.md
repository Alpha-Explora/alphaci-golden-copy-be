# Modular-monolith implementation alignment report

**Date:** 2026-08-28
**Trunk:** `codex/architecture-remediation-trunk`
**Scope:** the six-context consolidation and the follow-up remediation items
identified by the architecture review.

## Verdict

The current trunk is aligned with the approved progressive hexagonal-clean
modular-monolith target. It has six bounded-context directories, six context
root Nest modules, explicit kernel ports, provider registries/policies, one
scheduled outbox relay, schema ownership checks, and behavior-preserving
Projects use-case slices. The remaining limitations are external evidence
requirements or deliberate compatibility seams; none is a new known P0/P1
implementation defect.

This is not a claim of microservice readiness. The application remains one
NestJS deployable, and extraction remains future-only.

## Alignment matrix

| Plan area | Current state | Evidence |
|---|---|---|
| Six bounded contexts | complete | `src/modules/{identity-access,projects,pipelines,runtime,billing,platform-ops}` and six root modules |
| Kernel boundary | complete | `src/kernel/` contains technical DB/auth/HTTP/config/events and serialisable ports; it does not import contexts |
| Cross-context contracts | complete for actionable edges | public context indexes and focused ports; latest 32 cross-context imports are composition-only, with zero contract/application/actionable edges |
| Schema ownership | enforced | `scripts/check-schema-ownership.cjs` scans migrations and inline SQL with exact transition allowances |
| Outbox | corrected and operationally wired | active `published_at` acknowledgement, topic registry, retry/quarantine state, advisory lock, one Render cron and one dispatcher |
| Context-root composition | complete | `AppModule` imports the six roots; feature modules are composed behind them |
| Projects decomposition | materially complete | compatibility facade plus provisioning slices for single-repository, microservices-shaped, and multi-repository project flows, shared mechanics, dashboard, workflows, lifecycle, and reconciliation |
| Provider axis | generic plugin seam complete | Runtime-owned policies, metadata/client/workflow/CI registries, provider catalog port, open provider ids, and fake-provider acceptance coverage |
| Regression evidence | current and route-compatible | real HTTP boot, 145-route pre/current equality, current contract snapshots, provider acceptance, architecture gates |
| Build/CI hygiene | resolved locally and configured in CI | direct TypeScript build avoids the reproducible Nest CLI alias transformer failure; full ESLint is clean and CI runs the same gates |
| Database/operations | code and integration evidence prepared; external execution pending | conditional live Postgres test, migration dry-run, Render/Docker scheduler wiring, and honest evidence limits |
| Microservice extraction | future-only; outside current plan | no independent scaling, release cadence, or regulatory trigger has been evidenced |

## Current measurements

- 401 TypeScript source files, including 98 test files; 303 production files.
- 56 application files; 32 cross-context imports, all classified as Nest
  composition; zero contract/application/actionable edges; 15 directional
  context pairs.
- Dependency-cruiser: 382 modules, 1,544 dependencies cruised, zero
  violations.
- 145 routes. The recovered pre-consolidation inventory from `b175938` and the
  current inventory have identical SHA-256
  `d11dcda02cd737f38612b0b19f932b8e30d4b992d8c011d1a61e77415ddbf23a`.
- 64 migrations are discovered in globally sorted order by the dry-run.
- Jest: 130 passed suites plus one intentionally skipped suite; 1,247 passed
  tests plus two intentionally skipped tests; two snapshots passed.
- Full ESLint: 483 files, zero errors and zero warnings.

## Important corrections made after the review

1. Outbox acknowledgement updates the active
   `platform.outbox_events.published_at` column, never historical
   `processed_at`.
2. The Kafka-era runner was removed. `scripts/process-outbox.cjs` is the only
   runner, and Render contains one scheduled owner.
3. Relays select only topics registered by the dispatcher. Legacy unowned
   pending topics are quarantined by an explicit migration.
4. Critical hierarchy assignment grant/revoke state transitions write their
   outbox row in the same transaction. Audit and notification publishers are
   explicitly best-effort post-commit observability seams.
5. Metrics resolve aliased, relative, ESM, and CommonJS imports. The schema
   gate resolves DDL references and scans inline SQL without broad filename
   exemptions.
6. `AppModule` no longer wires feature modules one by one; the six context
   roots own that composition graph.
7. Provider-specific strategy, target, quota, URL, workflow, and fallback-log
   decisions moved behind provider-owned policy/registry seams. Historical
   Render/Vercel API and storage fields remain inside Runtime for compatibility.
   Projects intentionally retains the legacy `deploy_render` / `deploy_vercel`
   CI stage labels and the provider-host URL allowlist; these are compatibility
   and security surfaces, not provider orchestration.
8. The Projects provisioning hotspot was split along actual repository-shape
   use cases without changing its public constructor or setup ordering.
9. A real Express boot test and a recovered pre-consolidation route inventory
   close the prior weak boot/route evidence.

## Known evidence limits

- The source commit `b175938` did not contain a pre-consolidation contract
  snapshot, so current contract snapshots cannot prove retroactive equality.
- `SUPABASE_DB_URL` is absent in this worktree. The live Postgres integration
  test is available but intentionally skipped; static SQL checks and migration
  ordering do not claim live connectivity.
- Render cron execution and a production rollback rehearsal require deployment
  credentials and were not claimed as locally executed.

These limits are recorded rather than hidden. See
`docs/architecture/REMEDIATION_EVIDENCE.md` and
`docs/architecture/RESIDUAL_GAP_REPORT.md` for the complete evidence ledger.

## Decision

This is merge-candidate modular-monolith architecture work. Do not start
microservice extraction or add provider-specific top-level contexts unless a
measured operational trigger is documented. The next changes, if needed,
should be driven by live database/operations evidence or a real behavior-owning
use case—not by directory-count aesthetics.
