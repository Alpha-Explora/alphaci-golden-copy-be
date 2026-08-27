# Modular-monolith implementation alignment report

**Date:** 2026-08-27
**Trunk:** `codex/architecture-remediation-trunk`
**Scope:** the six-context consolidation and the remediation items identified
by the follow-up architecture review.

## Verdict

The consolidation is structurally aligned with the agreed plan. The current
trunk has six bounded-context directories, context-root Nest modules, generic
provider registries, explicit schema ownership, and a single scheduled outbox
relay. This report no longer treats directory count as proof of extraction
readiness: the remaining synchronous import volume and compatibility seams are
measured and documented.

## Alignment matrix

| Plan area | Current state | Evidence |
|---|---|---|
| Six bounded contexts | complete | `src/modules/{identity-access,projects,pipelines,runtime,billing,platform-ops}` and six root modules |
| Kernel boundary | complete | `src/kernel/` contains technical DB/auth/HTTP/events only; dependency-cruiser checks kernel imports |
| Cross-context contracts | implemented with residual seams | context barrels, `contracts/`, and focused port tokens; metrics remain descriptive rather than claiming zero coupling |
| Schema ownership | gate implemented | `scripts/check-schema-ownership.cjs` scans migrations and inline SQL; per-file transition allowances are explicit |
| Outbox | corrected | active table uses `published_at`; one compiled runner and one dispatcher; topic allow-list and advisory lock |
| Context-root composition | complete | `AppModule` imports the six roots, with feature composition behind them |
| Projects decomposition | materially improved | `ProjectsService` is a compatibility facade; provisioning, dashboard, workflow, lifecycle, and reconciliation implementations are focused services |
| Provider axis | generic seams complete; compatibility debt documented | provider metadata adapters, descriptor-driven slot policy, workflow fragments/target expansion, clients, and CI installers are registry-driven; provider implementations remain inside Runtime |
| Regression evidence | current reference captured | HTTP boot, route reference, provider acceptance, post-change snapshots, architecture gates |
| Microservice extraction | future-only; outside current plan | no independent scaling, release cadence, or regulatory trigger has been evidenced |

## Important corrections made after the review

1. The outbox acknowledgement now updates `platform.outbox_events.published_at`
   (the active migration column), never the historical `processed_at` name.
2. The Kafka-era runner and unsupported producers are gone. The only runner is
   `scripts/process-outbox.cjs`, wired as the `alphaci-outbox-relay` Render cron.
3. Relays select only topics registered by their dispatcher. Legacy pending
   topics are quarantined by an explicit migration rather than being silently
   acknowledged by a new handler.
4. Critical hierarchy assignment grant/revoke state transitions write their
   outbox row on the same transaction. Audit and notification publishers are
   explicitly best-effort post-commit observability seams; the documentation no
   longer promises stronger atomicity for them.
5. The architecture metric scanner counts aliased, relative, ESM, and CommonJS
   production imports. Dependency-cruiser remains the authoritative graph.
6. The schema gate applies allowances to exact schema/table references in exact
   files; it does not exempt an entire migration file by filename.
7. `AppModule` no longer wires feature modules one-by-one. The six context roots
   own that composition graph.
8. Provider workflow fragments are contributed by provider composition and
   selected by a generic registry. A fake-provider acceptance test exercises
   metadata, runtime client, workflow, and CI installer registration together.

## Known residual limitations

- Runtime still contains provider-specific compatibility logic for historical
  Render/Vercel storage columns, token configuration, legacy target/strategy
  identifiers, and compatibility DTO fields. Slot policy and workflow target
  expansion are now provider-owned/generic. This is within the Runtime ownership
  boundary and preserves existing API/database behavior; it is not yet a claim
  that a new provider is zero-edit outside its composition binding.
- The static cross-context metric is not an extraction proof. It reports the
  current alias-aware count so that future reductions are visible; see
  `docs/architecture/REMEDIATION_EVIDENCE.md` for the last measurement.
- The stored route reference and snapshots are post-consolidation references.
  A pre-consolidation route/contract snapshot was not captured retroactively,
  so route equality before the refactor cannot be proven from this repository.
- Database integration tests are conditional on `SUPABASE_DB_URL`; local runs
  without that secret validate SQL strings and migration dry-run ordering but do
  not prove connectivity to the live database.
- The rollback proof is commit/revert discipline. No destructive reset or
  branch deletion is part of this remediation.

## Decision

This is merge-candidate modular-monolith architecture work, not completed
microservice readiness. Microservice extraction is outside the current plan and
should only be reopened when an operational trigger is recorded. The next safe
improvements are provider compatibility extraction or further Projects
application slicing, not new top-level modules.
