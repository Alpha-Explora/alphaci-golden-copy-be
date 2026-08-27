# Residual architecture gaps

**Date:** 2026-08-28
**Trunk:** `codex/architecture-remediation-trunk`

This report closes the follow-up review against the adopted six-context,
progressive hexagonal-clean modular-monolith direction. It separates fixed
implementation defects from evidence that requires an external database or
deployment environment. Microservice extraction is deliberately deferred.

## Closed on this trunk

| Review finding | Resolution |
|---|---|
| Outbox used `processed_at` against the active table | The relay acknowledges with `status='published'`, `published_at`, and `updated_at`. |
| Two competing outbox runners | The Kafka-era runner/types were removed; `scripts/process-outbox.cjs` is the sole runner. |
| Relay could consume unsupported topics | Dispatcher registration and SQL topic filtering are required; legacy rows are quarantined explicitly. |
| No scheduler wiring | Render has exactly one `alphaci-outbox-relay` cron using the compiled runner. |
| Outbox guarantee was overstated | Critical hierarchy transitions use `publishInTransaction`; audit/notification are documented as best-effort post-commit. |
| Metrics reported aliased edges as zero | The scanner resolves aliases and common module syntaxes; dependency-cruiser remains authoritative. |
| Schema gate had broad filename exemptions | Allowances are exact file plus exact schema.table pairs and inline SQL is scanned. |
| AppModule exposed feature-module wiring | Six context-root modules now own feature composition. |
| Projects god-service hotspot | Provisioning is split by real repository shape/use case; dashboard, workflow, lifecycle, and reconciliation are focused application slices; the facade only preserves compatibility. |
| Provider acceptance was missing | Generic registries and open-id seams are exercised by a fake provider across metadata, policy, client, workflow, CI, and staged generation. |
| HTTP boot was not real | `createHttpApplication()` boots the Express adapter and serves the health endpoint in architecture tests. |
| Nest CLI build was unstable with current aliases | The package build uses direct `tsc -p tsconfig.build.json`; typecheck/build pass and Node package-import mappings remain intact. |
| Repository-wide lint was obscured by line endings | `.gitattributes`/ESLint alignment and formatting now produce zero errors and warnings across 483 files. |
| Route equality had no pre-change reference | A 145-route pre-consolidation inventory was recovered from `b175938`; it matches the current inventory byte-for-byte. |

## Remaining limitations and evidence boundaries

### P2 — Pre-change contract snapshot was never captured

The source commit `b175938` contains no old contract snapshot. Current
`tests/architecture/contract-snapshots.spec.ts` protects the present provider
and workflow shape from future drift, but no repository evidence can prove
retroactive contract equality for the original consolidation.

### P2 — Live Postgres execution requires credentials

`tests/integration/database.integration.spec.ts` performs live schema,
retry/quarantine, acknowledgement, and transaction rollback assertions when
`SUPABASE_DB_URL` is provided. This worktree has no `SUPABASE_DB_URL`, local
Postgres binary, or running Docker database, so the live test is skipped. The
64-migration dry-run and static schema gate are valid complementary evidence,
not a substitute for a live connection.

### P2 — Deployed operations require deployment access

`render.yaml`, `Dockerfile`, and `tests/architecture/outbox-scheduler.spec.ts`
prove that one cron owner is configured and invokes the compiled relay. Actual
cron execution, production metrics, and a rollback rehearsal require Render
credentials and a deployed environment; they were not simulated as if they
had run.

### P2 — Runtime compatibility debt remains intentionally in Runtime

Historical Render/Vercel fields, strategy identifiers, token/scope selection,
and DTO/storage values remain because changing them would change the public or
database contract. Provider policies, generic registries, workflow fragments,
target expansion, clients, and CI installers keep new provider behavior out of
other contexts. Projects also retains the legacy `deploy_render` /
`deploy_vercel` CI stage labels and provider-host URL allowlist because those
are compatibility/security surfaces, not provider orchestration. Adding a
provider still requires normal Runtime composition registration; it does not
require a new top-level context.

### P2 — The monolith still has composition imports

The latest alias-aware metric reports 32 cross-context imports across 15
directional pairs, all classified as explicit Nest composition. Contract and
application cross-context imports are zero, and dependency-cruiser reports no
violations. This is a healthy current modular-monolith boundary, not proof of
independent service deployment.

## Deferred by decision

- Keep microservice extraction outside the current plan. Reopen it only with a
  measured independent-scaling, deployment-cadence, or regulatory-isolation
  trigger.
- Do not add a seventh context for a provider or deployment mode.
- Do not redesign schemas, roles, or search paths merely to make the tree look
  service-like.
- Do not further split the provisioning support slice without a distinct
  behavior-owning use case and tests; wrapper-only decomposition would make
  the boundary less clear, not more.

The authoritative measurements and commands are in
`docs/architecture/REMEDIATION_EVIDENCE.md`.
