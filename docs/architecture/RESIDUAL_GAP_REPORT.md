# Residual architecture gaps

**Date:** 2026-08-27
**Trunk:** `codex/architecture-remediation-trunk`

This is the honest follow-up to the six-context consolidation review. It
distinguishes defects fixed on the trunk from limitations that are deliberate
compatibility or evidence gaps.

## Closed on this trunk

| Review finding | Resolution |
|---|---|
| Outbox used `processed_at` against the active table | Relay acknowledges with `status='published'`, `published_at`, and `updated_at`. |
| Two competing outbox runners | Kafka-era runner/types removed; `scripts/process-outbox.cjs` is the only runner. |
| Relay could consume unsupported topics | Dispatcher registration and SQL topic filtering are required; legacy rows are quarantined explicitly. |
| No scheduler wiring | Render has exactly one `alphaci-outbox-relay` cron using the compiled runner. |
| Outbox guarantee was overstated | Critical hierarchy transitions use `publishInTransaction`; audit/notification are labeled best-effort post-commit. |
| Metrics reported aliased edges as zero | The scanner counts aliases and common module syntaxes; dependency-cruiser remains authoritative. |
| Schema gate had broad filename exemptions | Allowances are exact file plus exact schema.table pairs and inline SQL is scanned. |
| AppModule exposed feature-module wiring | Six context-root modules now own feature composition. |
| Projects god-service hotspot | Provisioning, dashboard, workflow, lifecycle, and reconciliation logic moved to application slices; the facade remains only for compatibility. |
| Provider acceptance was missing | Registries are generic/open-id and the architecture suite exercises a fake provider across all contribution types. |
| HTTP boot was not real | `createHttpApplication()` boots the Express middleware and serves the health endpoint in architecture tests. |

## Remaining limitations (intentional or evidence-bound)

### P1 — Future extraction is not currently a deliverable

The current alias-aware metric still reports cross-context imports. Some are
composition wiring or compatibility reads inside the same deployable; others
are genuine synchronous application edges. A future extraction must reduce the
relevant edges to serialisable contracts and transport-swappable ports rather
than relying on the directory count.

Runtime also retains historical provider-specific storage fields, token/scope
selection, legacy strategy identifiers, and compatibility DTO fields. Workflow
target expansion and slot policy are now provider-owned and generic. The
remaining compatibility adapters stay inside Runtime so public behavior and
database values do not change; extracting them is a separate slice, not a
reason to move provider code into other contexts.

### P1 — Projects still has a large application slice

`ProjectsService` is now a facade and no longer owns the former 2,500-line
workflow implementation. `ProjectProvisioningApplicationService` remains the
largest focused slice because it preserves the complete existing setup
workflow. Further splitting should follow use-case ownership and tests; do not
create wrappers that only rename calls.

### P2 — Historical regression evidence is unavailable

The route files and contract snapshots are post-consolidation references. The
repository does not contain a pre-consolidation route or contract snapshot, so
retroactive equality cannot be claimed. The route manifest records this fact
and hashes the current reference. New changes must update it only through the
route-inventory test.

### P2 — Database verification depends on environment

Migration replay ordering is verified by `scripts/apply-all-migrations.mjs
--dry-run`, and SQL ownership is statically checked. The Postgres integration
test runs only when `SUPABASE_DB_URL` is provided. A local run without that
secret cannot prove live connectivity or transaction behavior.

### P2 — Rollback evidence is procedural

The remediation is committed on the named trunk and can be reverted as a
normal commit. No destructive reset, force push, branch deletion, or worktree
cleanup is needed to establish the result. A production rollback rehearsal
requires the deployment environment and is intentionally outside this code
change.

## Deferred by decision

- Keep microservice extraction outside the current plan. Reopen the future
  option only with an independent scaling, deployment-cadence, or regulatory
  trigger.
- Do not add a seventh context for a provider or deployment mode.
- Do not redesign schemas/roles/search paths merely to make the tree look more
  service-like.

The authoritative current measurements and command results live in
`docs/architecture/REMEDIATION_EVIDENCE.md`.
