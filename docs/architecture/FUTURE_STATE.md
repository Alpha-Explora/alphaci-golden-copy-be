# AlphaCI Enterprise Backend — Future State Architecture

**Status:** proposed. Nothing in this document is landed yet.
**Supersedes:** `README.md` and `START_HERE_BACKEND.md`, which still describe the
retired tribe-backend template (they document an `src/api-center/` module and a
Supabase-JS data layer that no longer exist).
**Sibling reference:** `../alphaci-be/docs/architecture/hexagonal-hybrid.md` —
the same migration, already executed for the multi-tenant SaaS product. This
document reuses what worked there and closes two gaps it left open.

---

## 0. Decisions locked

| # | Decision | Choice |
|:-:|----------|--------|
| 1 | Deployable topology | **Split into per-context services**, Turborepo monorepo |
| 2 | Hosting model | **Single-tenant** — dedicated deployment and database per enterprise customer |
| 3 | Migration approach | **Incremental strangler** — feature work continues throughout |
| 4 | Hierarchy placement | **Folded into `identity-access`** with identity and orgs |

### Constraints that follow

- **One database per tenant.** Schema separation is the isolation boundary
  *inside* a customer's database, exactly as in `alphaci-be`. Cross-tenant
  isolation is now physical (separate databases), which is a stronger position
  than the SaaS product has.
- **Feature velocity is protected.** ~313 commits in the last 90 days across 3
  active developers. Every phase below is independently revertible and leaves
  the service deployable.
- **Decisions 1 and 2 multiply.** 6 services × N customers is the operational
  cost of this combination. Section 3 is the design that keeps that number from
  becoming 6N containers to babysit; it is the most important section in this
  document.

---

## 1. Current state (measured, not estimated)

### Code

| Metric | Value |
|--------|------:|
| Feature modules | 19 |
| Production TS (`src/**`, excl. specs) | ~38,000 LOC |
| TS files | 302 |
| Spec files | 94 |
| Controllers | 26 |
| Repositories | 31 |
| Deployables | 1 (Render, single GHCR image) |

Six modules are under 400 LOC (`capabilities` 96, `audit` 177, `feedback` 291,
`usage` 316, `database` 362, `notifications` 382). Three carry most of the
weight:

| Module | LOC | Controllers | Repositories |
|--------|----:|:-----------:|:------------:|
| `projects` | 9,184 | 2 | 5 |
| `hierarchy` | 6,637 | 7 | 9 |
| `env-provisioning` | 5,855 | 3 | 3 |
| `github` | 3,383 | 2 | 1 |

`modules/projects/projects.service.ts` alone is 4,545 lines with a 3,424-line
spec, and fans out to 43 `githubService` calls. It is the primary target for
domain extraction.

### Data

19 schemas hold roughly 55 tables. Nine of them hold 1–3 tables each (`ci`,
`platform`, `audit`, `support`, `gcp_operations`, `billing_lifecycle`,
`runtime_secrets`, `runtime_domains`, `runtime_deployments`). The schema layout
has the same fragmentation as the module layout.

Actual cross-schema access today, taken from `FROM`/`JOIN`/`INSERT`/`UPDATE`
statements in repository files:

| Module | Schemas touched |
|--------|-----------------|
| `admin` | audit, billing, identity, projects, workflow |
| `usage` | billing, env_provisioning, identity, projects |
| `ci` | billing, ci, projects, workflow |
| `projects` | hierarchy, identity, orgs, projects |
| `hierarchy` | audit, hierarchy, identity, orgs |
| `workspaces` | identity, orgs, projects |
| `env-provisioning` | env_provisioning, orgs, projects |
| `audit` | audit, projects |

`projects` and `identity` are each read by seven modules. That is the coupling
this design has to answer, not wish away.

### The authorization predicate

`modules/projects/projects.repository.ts` builds `projectVisibilitySql`, the
predicate behind every project list endpoint. It resolves in one `WHERE` clause
across four schemas:

```
identity.app_users          (app_role = 'admin')
identity.platform_admins
orgs.workspace_members      (member_status = 'active')
hierarchy.repositories + hierarchy.repository_assignments
projects.provisioned_projects
```

Any context boundary drawn between identity, orgs and hierarchy turns this
single query into a distributed authorization problem whose failure mode is
silent over-permission. **This is why decision 4 folds hierarchy into
identity-access.** Keeping those three schemas under one owner keeps the
predicate a single in-context query.

---

## 2. Target shape

Turborepo workspace, seven deployables, six owned schema sets.

```text
alphaci-enterprise-be/
├── apps/
│   ├── edge-gateway/          public entry; no database
│   ├── identity-access/       auth, users, orgs, hierarchy, admin
│   ├── projects/              projects, catalog, workflows, existing-repos
│   ├── pipelines/             github, ci
│   ├── runtime/               env-provisioning, deployment targets
│   ├── billing/               subscriptions, usage quotas
│   └── platform-ops/          notifications, feedback, support
├── libs/
│   ├── contracts/             event contracts + shared interfaces, no behavior
│   ├── db/                    role-aware pool, ssl config, search_path
│   ├── messaging/             outbox, relay, pull consumer, idempotent inbox
│   ├── platform/              guards, middleware, filters, health, ports
│   └── composition/           ← new: bundled vs split composition roots
├── db/
│   └── migrations/<owner>/    identity, projects, pipelines, runtime,
│                              billing, platform
├── scripts/                   architecture gates (section 8)
└── deploy/
    └── tenants/               per-customer release manifests (section 7)
```

### Context map

| Context | Owns schemas | Absorbs modules | ~LOC |
|---------|--------------|-----------------|-----:|
| `identity-access` | `identity`, `orgs`, `hierarchy` | auth, persistence, workspaces, hierarchy, admin, capabilities | 10,900 |
| `projects` | `projects`, `workflow` | projects, catalog, workflows, existing-repos | 12,100 |
| `pipelines` | `ci`, `github_app` | github, ci | 4,800 |
| `runtime` | `env_provisioning`, `runtime_deployments`, `runtime_domains`, `runtime_secrets`, `gcp_operations` | env-provisioning | 5,900 |
| `billing` | `billing`, `billing_lifecycle`, `usage` | subscription, usage | 800 |
| `platform-ops` | `notifications`, `support` | notifications, feedback | 700 |
| `edge-gateway` | — | *(new)* | ~600 |
| *sanctioned shared* | `platform` (outbox/inbox), `audit` (append-only) | audit | — |

19 schemas consolidate to 6 owned sets plus 2 sanctioned shared. `audit` and
`platform` are declared shared rather than assigned an owner, because
audit-write and the outbox are legitimately cross-cutting — the same call
`alphaci-be` makes for `platform.outbox_events`, made explicit here instead of
implicit.

`billing` and `platform-ops` are small (800 and 700 LOC). They get their own
context because they own distinct schemas and have distinct external
integrations (PayMongo; email/notifications), not because their size warrants
it. Expect them to stay thin.

---

## 3. Dual composition root

**The problem.** Decision 1 (split) and decision 2 (single-tenant) multiply. Six
services per customer means a ten-customer install base is 60 running services,
60 sets of environment variables, and 60 health checks — for a product whose
services all share one database per tenant and therefore cannot be deployed
independently anyway (section 7).

**The design.** One codebase, one image, two composition roots. Each context is
a NestJS module that can be mounted either into its own process or all together
into one.

```text
libs/composition/
├── contexts.ts            registry: name → root module + owned schemas
├── bootstrap-split.ts     one context per process, selected by SERVICE_NAME
└── bootstrap-bundled.ts   all contexts in one process, one Nest app
```

The Docker entrypoint picks the mode:

```dockerfile
# One image contains every context.
ENV DEPLOY_MODE=bundled
CMD ["node", "dist/libs/composition/main.js"]
```

```bash
# Split mode — six containers from the same image
DEPLOY_MODE=split SERVICE_NAME=projects

# Bundled mode — one container, all contexts
DEPLOY_MODE=bundled
```

### What differs between modes

| Concern | Split | Bundled |
|---------|-------|---------|
| Processes per tenant | 6 + gateway | 1 |
| Cross-context calls | HTTP + internal JWT | in-process adapter |
| Routing | edge-gateway proxies first path segment | Nest router, gateway module optional |
| DB pools | 1 per service, own role | 6 in one process, own role each |
| Session lookup | HTTP to `identity-access` | in-process |
| Failure isolation | per context | none |

### Why the ports stay honest

`alphaci-be` deleted 24 `in-process-*.adapter.ts` files because they were dead —
production only ever used the HTTP path, so the port had one live
implementation and the abstraction wasn't paying for itself. Its rule became
*"ports ONLY when 2+ implementations exist."*

Under bundled mode, **both adapters are live in production.** Small customers
run in-process; large customers run split. That satisfies the rule on its own
terms rather than in spite of it, and it is the reason this design is cheaper
here than it was there.

```text
apps/projects/src/application/ports/account-directory.port.ts   ← interface
apps/projects/src/infrastructure/adapters/
├── http-account-directory.adapter.ts        split mode
└── in-process-account-directory.adapter.ts  bundled mode
```

The composition root selects the adapter from `DEPLOY_MODE`. Application code
never learns which one it got.

### Connection budget

This matters here specifically — `modules/database/database.service.ts` carries
a long comment about an `EMAXCONNSESSION` incident caused by three pools sharing
a Supavisor `pool_size: 15`. Under single-tenant each customer has their own
database, which relieves that pressure, but bundled mode puts six pools in one
process and needs sizing.

| Mode | Formula | At `pool_size: 15` |
|------|---------|-------------------|
| Bundled | 6 contexts × `max` + session pool | `max: 2` → 12 + 2 = 14 |
| Split | per service `max` × instances + session | `max: 3` → fits with ≤2 instances |

`libs/db` must read `max` from env per context, not hardcode it, and log the
resolved total at boot. Keep the fingerprint logging that already exists in
`DatabaseService` — it has earned its place.

---

## 4. Internal structure per context

Hexagonal-clean hybrid, ported from `alphaci-be` including its restraints.

```text
apps/<context>/src/
├── domain/            entities + invariants — ONLY where rules exist
├── application/
│   ├── types/         request-side contracts (source of truth)
│   ├── use-cases/     orchestrate domain + ports
│   └── ports/         ONLY where 2+ implementations exist
├── infrastructure/
│   ├── db/            concrete repositories, own schemas only
│   ├── clients/       github, render, vercel, paymongo, gcp
│   └── adapters/      implementations of application ports
├── http/
│   ├── controllers/   session-guarded public routes
│   ├── dto/           mirrors application/types
│   └── internal/      x-internal-token routes, split mode only
├── public-api/        outward contract other contexts may import types from
└── main.ts            composition root only
```

### Rules

1. **No empty layers.** A `domain/` folder appears only when an invariant needs
   a home. `alphaci-be` measured 6 domain files across 7 services and that was
   the correct number.
2. **Own-schema repository is a concrete class**, not a port. One database, one
   implementation — a port would be ceremony.
3. **Ports only at real seams**: a second implementation (bundled/split), a test
   fake that earns its keep, or a genuine future substitution.
4. **`http/dto` mirrors `application/types`.** DTOs never import into
   application code; the dependency runs one way.
5. **`main.ts` is composition only** — guards and config wired there, not
   re-abstracted.
6. **No use-case class per operation.** `alphaci-be` explicitly dropped that
   from its earlier ADR as not paying for itself. Use-cases where they clarify,
   direct service methods where they don't.

### Conversion order

Highest coupling first, so the hardest boundary is proven before the easy ones:

`projects` → `identity-access` → `pipelines` → `runtime` → `billing` → `platform-ops`

`projects.service.ts` (4,545 lines) is first because it is both the worst file
and the one whose domain extraction de-risks everything downstream.

---

## 5. Data architecture

### Schema ownership

```text
one database per tenant
├── public       shared session table (read by all contexts)
├── identity     ─┐
├── orgs          ├─ owned by  alphaci_ctx_identity
├── hierarchy    ─┘
├── projects     ─┐ owned by  alphaci_ctx_projects
├── workflow     ─┘
├── ci           ─┐ owned by  alphaci_ctx_pipelines
├── github_app   ─┘
├── env_provisioning, runtime_*, gcp_operations  owned by alphaci_ctx_runtime
├── billing, billing_lifecycle, usage            owned by alphaci_ctx_billing
├── notifications, support                       owned by alphaci_ctx_platform_ops
├── platform     sanctioned shared — outbox_events, inbox_events
└── audit        sanctioned shared — append-only, INSERT + SELECT for all
```

### Per-context roles, actually wired

This is the first of two gaps to close from `alphaci-be`.

There, `db/migrations/platform/20260809000000_service_schema_roles.sql` creates
seven correctly-scoped `NOLOGIN` roles — and `SERVICE_DB_ROLE` is set in no
Terraform file and no workflow. It appears only in `libs/db/src/database.service.ts`
and its spec. Every service still connects on the broad default credential.

`SERVICE_SEARCH_PATH` *is* deployed per service, but **`search_path` only
resolves unqualified table names — it is not a permission boundary.** A
schema-qualified `FROM projects.provisioned_projects` ignores it entirely. That
is the complete explanation for the 17 cross-schema reads currently live in that
codebase: they were never capable of failing.

Here, both are set from phase 0, in bundled and split mode alike:

```bash
CTX_DB_ROLE=alphaci_ctx_projects
CTX_SEARCH_PATH=projects,workflow,platform,audit,public
```

In bundled mode each context's pool sets its own role, so Postgres enforces the
boundary even inside a single process. A cross-context read then fails loudly in
development instead of working silently forever.

### The two irreducible cross-context reads

After the regrouping in section 2, two tables are still read from nearly
everywhere and no further regrouping fixes it:

- `projects.provisioned_projects` — billing (quotas), pipelines (CI reports),
  runtime (targets), identity-access (workspace and admin views)
- `identity.app_users` — authorization, almost everywhere

`alphaci-be` hit exactly the same two, which is good evidence this is structural
rather than a mistake. It resolved them with ambient privilege. We resolve them
with an explicit contract: **owner-defined read-only views in the shared
schema.**

```sql
-- Owned and versioned by the projects context. The view definition IS the
-- contract; consumers get no rights on the base table.
CREATE VIEW platform.v_project_ref AS
SELECT id, workspace_id, user_id, repo_full_name, status, is_example
FROM projects.provisioned_projects;

GRANT SELECT ON platform.v_project_ref TO
  alphaci_ctx_billing, alphaci_ctx_pipelines,
  alphaci_ctx_runtime, alphaci_ctx_identity;

-- Owned by identity-access.
CREATE VIEW platform.v_user_ref AS
SELECT id, login, app_role, is_internal, archived_at
FROM identity.app_users;

GRANT SELECT ON platform.v_user_ref TO
  alphaci_ctx_projects, alphaci_ctx_billing,
  alphaci_ctx_pipelines, alphaci_ctx_runtime, alphaci_ctx_platform_ops;
```

Properties this buys:

- The owning context controls the exposed column set; a base-table change that
  doesn't alter the view is invisible to consumers.
- Postgres enforces it — no gate or review needed to prevent base-table access.
- It behaves identically in bundled and split mode, and identically before and
  after any future database split.
- Narrow by construction: `SELECT` only, named columns, no writes.

**Writes never cross a context.** A context that needs another context's data
changed calls a port (section 6).

### Migrations

Move `supabase/migrations/*.sql` (65 flat files) to `db/migrations/<owner>/`,
preserving timestamps. Keep the existing `scripts/apply-migrations.ts` runner
and extend it to walk owner folders in timestamp order across all folders, so
apply order stays global while ownership stays visible.

Port `check-db-schema-ownership.cjs` — it fails a migration that declares a
schema-qualified `REFERENCES` outside its owner's schema set.

### Row-level security

16 migrations enable RLS today. Under single-tenant, tenant isolation comes from
the separate database, so RLS is no longer the primary boundary — keep it as
defense-in-depth and do not add new RLS policies as a substitute for the role
grants above. Two mechanisms guarding the same boundary in different ways is
fine; two mechanisms that must agree to be correct is not.

---

## 6. Cross-context communication

### Synchronous

Every cross-context call goes through a typed port in
`application/ports/`, with two adapters:

- **split** → HTTP to the sibling's `http/internal/` routes, carrying
  `x-internal-token` signed with `INTERNAL_JWT_SECRET`
- **bundled** → in-process adapter calling the sibling module directly

No context ever imports another context's service, repository, or module. Only
`public-api/` types may be imported across contexts, and only types.

### Session and identity

Port the `SESSION_USER_LOOKUP_PORT` pattern from
`alphaci-be/libs/platform/src/internal/session-user-lookup.module.ts`. Today
`common/guards/session-auth.guard.ts` injects `UsersRepository` directly, which
cannot survive the split.

| Mode | Implementation |
|------|----------------|
| Bundled | in-process lookup against `identity` schema |
| Split | HTTP to `identity-access`; boot throws if its URL is unset |
| Dev | direct DB lookup, non-production only |

The `express-session` store stays on `public.session`, readable by every
context — the one genuinely shared table, granted `SELECT` explicitly.

### Asynchronous

Outbox → queue → idempotent inbox, reusing the pattern already working in
`modules/hierarchy/github-sync/github-sync-outbox.worker.ts` (`FOR UPDATE SKIP
LOCKED`, batch 20, `.catch()` at the scheduling boundary — keep that comment,
it documents a real crash-loop).

**Rule: only events with a real consumer travel through the queue.** This is
rule 7 from `hexagonal-hybrid.md` and it is the reason that codebase has one
subscription rather than eleven speculative ones. Everything else stays
synchronous while one database per tenant stands.

For single-tenant, prefer the Postgres-backed outbox with an in-process relay
over a managed broker. It removes a per-customer piece of infrastructure, and
the existing worker already does the hard part.

### Contracts

`libs/contracts/` holds event payloads and shared interfaces only, with no
behavior and no imports from `apps/`. Topics come from a registry constant, never
a string literal — `alphaci-be` audit finding 11.

---

## 7. Single-tenant deployment

### Services deploy as a versioned set, not independently

Stating this plainly because it is the main expectation to correct: with one
database per tenant, a `projects` schema migration must be compatible with every
context reading `platform.v_project_ref`. So contexts are released **together,
as a pinned set**, not on independent cadences. The split buys failure
isolation, independent scaling, and boundary enforcement. It does not buy
independent deploys while one database stands.

```yaml
# deploy/tenants/<customer>/release.yaml
release: 2026.09.1
mode: split                     # or: bundled
image: ghcr.io/alpha-explora/alphaci-enterprise-be@sha256:…
services:
  edge-gateway:     { replicas: 2, port: 8080 }
  identity-access:  { replicas: 2 }
  projects:         { replicas: 2 }
  pipelines:        { replicas: 1 }
  runtime:          { replicas: 1 }
  billing:          { replicas: 1 }
  platform-ops:     { replicas: 1 }
database:
  url_secret: alphaci-<customer>-db-url
  migrations_applied_through: 20260818020000
```

One image digest for every service in the set. A release is a digest plus a
migration high-water mark.

### Customer tiers

| Tier | Mode | Containers | When |
|------|------|-----------:|------|
| Standard | bundled | 1 | default; most customers |
| Scale | split | 7 | contention, or a customer needing isolated scaling |

A customer moves between tiers by changing `mode` and redeploying — same image,
same database, same migrations. This is the payoff of section 3, and the reason
the split does not cost 6N containers.

### Provisioning a new customer

1. Create the database; apply `db/migrations/**` in global timestamp order.
2. Create the six `alphaci_ctx_*` roles and grants; create the shared views.
3. Generate per-context env from the tenant manifest (`CTX_DB_ROLE`,
   `CTX_SEARCH_PATH`, `INTERNAL_JWT_SECRET`, GitHub App credentials).
4. Deploy at the pinned digest in the tier's mode.
5. Verify `/api/v1/health` through the gateway, then the per-context health
   endpoints.

Steps 1–3 must be a single scripted command. With single-tenant, provisioning
runs on every new customer — it is a product surface, not a one-off.

### What stays central

GitHub App registration, the workflow-template catalog, and the release pipeline
stay central. Per-tenant configuration must never require a code change; today
`config/app.config.ts` reads ~40 GitHub/provider settings from env, which is the
right shape for this already.

---

## 8. Enforcement

Architecture that CI does not check will decay — `alphaci-be` proved both halves
of that, in the gates that hold and the one that doesn't.

| Gate | Source | Checks |
|------|--------|--------|
| `check:boundaries` | ported | no context imports another context |
| `check:application-boundaries` | ported | application layer imports no infrastructure except own-schema repos |
| `check:schema-ownership` | ported | no cross-owner FK `REFERENCES` in migrations |
| `report:architecture-metrics` | ported | per-context shape counts, JSON for CI |
| **`check:sql-ownership`** | **new** | **no runtime SQL against a schema the context doesn't own** |
| **`check:role-wiring`** | **new** | **every context has `CTX_DB_ROLE` + `CTX_SEARCH_PATH` set in every deploy manifest** |

### `check:sql-ownership`

The gate that would have caught all 17 leaks in `alphaci-be`. Cheap to write
here because every query lives in a template literal inside a
`*.repository.ts`.

- Scan `apps/<ctx>/src/**` for `FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM <schema>.<table>`
- Fail unless the schema is owned by that context, sanctioned shared
  (`platform`, `audit`, `public`), or a `platform.v_*` view
- Report file, line, and the offending schema

Run it against the existing `src/modules/**` from day one, with the current 12
cross-schema repositories as an explicit, shrinking baseline. Every phase
reduces the baseline; the number going up fails the build.

### `check:role-wiring`

Guards specifically against the `alphaci-be` failure: a role migration that
exists while nothing uses it. Asserts every context in
`libs/composition/contexts.ts` has both env vars present in every
`deploy/tenants/*/release.yaml`, and that `libs/db` throws at boot when either is
missing outside development.

All six run in CI alongside `typecheck`, `lint`, `test`, `build`.

---

## 9. Migration plan

Incremental strangler. Every phase ships, is revertible, and leaves feature work
unblocked. No phase requires a freeze.

### Phase 0 — Enforcement before restructuring

Gates first, so every later phase is measured rather than asserted.

- Turborepo scaffold: `apps/`, `libs/`, `turbo.json`. Existing `src/` stays put
  and still builds and deploys.
- Write all six gates. Run them against today's `src/modules/**`. Record the
  baseline: 12 cross-schema repositories, 17-ish cross-schema reads.
- Move `supabase/migrations/**` → `db/migrations/<owner>/**`; extend the runner.
- Create the six `alphaci_ctx_*` roles + grants, and the two shared views. Do
  not wire them yet.

*Exit:* CI runs six gates and reports a baseline. Production unchanged.
*Revert:* delete the gates and the scaffold.

### Phase 1 — `libs/` extraction

- `libs/db` from `modules/database` — add `CTX_DB_ROLE` / `CTX_SEARCH_PATH`,
  keep the connection fingerprint logging and the retry classification.
- `libs/platform` from `common/` — guards, filters, correlation middleware,
  health. Invert `SessionAuthGuard` onto `SESSION_USER_LOOKUP_PORT` so it no
  longer injects `UsersRepository`. **This is `alphaci-be` audit finding 1** —
  its shared kernel depended upward on apps. Do not repeat it: `libs/` may never
  import from `apps/`, enforced by `check:boundaries`.
- `libs/contracts`, `libs/messaging` from `modules/persistence/outbox.repository.ts`
  and the hierarchy outbox worker.

*Exit:* one deployable, now consuming `libs/`. Roles wired, still bundled.
*Revert:* per-lib; each is an independent commit.

### Phase 2 — First context: `projects`

The hardest boundary, proven first.

- `apps/projects/` with the full onion layout. Move projects, catalog,
  workflows, existing-repos.
- Extract a real domain layer from `projects.service.ts`: `Project` aggregate,
  provisioning invariants, `project.created` derived from domain events.
- Replace its reads of `identity`/`orgs`/`hierarchy` with
  `platform.v_user_ref` and an `account-directory` port.
- Both adapters — in-process and HTTP — written now, with the in-process one
  live.

*Exit:* `check:sql-ownership` baseline drops. Still one process, one deployable.
*Revert:* the context is additive until the old module is deleted; delete last.

### Phase 3 — `identity-access`

- Move auth, persistence, workspaces, hierarchy, admin, capabilities.
- `projectVisibilitySql` stays one query — identity, orgs and hierarchy are
  co-owned here, which was the point of decision 4. Its one outside reference
  becomes `platform.v_project_ref`.
- Stand up `http/internal/` routes for session lookup and the account directory.

*Exit:* two contexts. Cross-context traffic exercised in-process.

### Phase 4 — Remaining contexts

`pipelines` → `runtime` → `billing` → `platform-ops`, same recipe each time.
`runtime` keeps the provider-client registry and the `stub`/`live` provider
pattern, which is already the right shape.

*Exit:* `src/modules/` is empty and deleted. `check:sql-ownership` baseline is
zero. One deployable in bundled mode.

### Phase 5 — Split mode and the gateway

- `apps/edge-gateway/`: first-path-segment routing, internal JWT minting,
  HTTPS-required-in-production with a startup throw. Copy
  `alphaci-be/apps/edge-gateway/src/proxy/service-routes.ts` and its
  no-localhost-fallback-in-prod rule.
- Turn on the HTTP adapters. Run split mode in staging against the same
  database.
- Contract-test every internal route in both modes; both must pass every suite.

*Exit:* one image runs either mode. Production still bundled.
*Revert:* set `DEPLOY_MODE=bundled`. This is the safety property the whole
design is built around.

### Phase 6 — Tenant packaging

- `deploy/tenants/<customer>/release.yaml`; scripted provisioning (section 7).
- Move existing customers to bundled-mode manifests.
- Promote the first customer to split mode only when a real signal justifies it.

*Exit:* per-customer releases from pinned digests, both tiers supported.

### Note on the gateway route names

`alphaci-be`'s gateway matches on first path segment only, which forced
`project-members` and `runtime-secrets` to become top-level segments — there are
apologetic comments in `service-routes.ts` about it. Decide the public URL
taxonomy in phase 5 *before* routes are locked, or accept the same distortion.
Prefixing internal routes (`/api/v1/_internal/<ctx>/…`) keeps the public surface
free of topology.

---

## 10. What this improves, and what it costs

### Improves

| | |
|---|---|
| Enforced boundaries | Postgres rejects cross-context access; six CI gates catch the rest at review time |
| Module sprawl | 19 modules → 6 contexts with owned schemas and clear ownership |
| The 4,545-line service | Broken into a real domain layer under phase 2 |
| Deployment flexibility | One image serves both a 1-container and a 7-container customer |
| Testability | Ports at real seams make cross-context behavior fakeable without HTTP |
| Future database split | Roles and search_path are already per-context; the split becomes configuration |
| Onboarding | Contexts map to product language; the stale template docs get replaced |

### Costs accepted

| | |
|---|---|
| No independent deploys | One database per tenant means releases ship as a pinned set (section 7) |
| Two modes to test | Every internal contract needs coverage in both; CI time roughly doubles for that suite |
| Provisioning is now a product surface | Single-tenant means the scripted path runs on every new customer, not once |
| Migration duration | Six phases with 3 developers and continuing feature work — expect quarters, not weeks |
| Split-mode operations | Gateway, internal JWT, per-context health and logs; only paid for scale-tier customers |

### Honest note on the topology choice

A modular monolith would deliver every row in the "improves" table except
failure isolation and independent scaling, at materially lower operating cost —
the boundary work is identical either way, because the schema roles do the
enforcing and they are indifferent to process count. The split was chosen
anyway; section 3 is the design that keeps its cost proportional, and phase 5's
revert is a single environment variable. If split mode reaches staging and the
operational load looks wrong, staying bundled is a supported end state, not a
retreat.

---

## 11. Open decisions

These need answers before the phase they gate. None block phase 0.

| # | Question | Gates |
|:-:|----------|-------|
| 1 | **Runtime platform for enterprise installs** — stay on Render, or containers/K8s per customer? Render's per-service model fits split mode poorly for single-tenant; `alphaci-be`'s Cloud Run + Terraform is closer but is multi-tenant SaaS. | Phase 6 |
| 2 | **Who operates a tenant deployment** — us (hosted single-tenant) or the customer (self-hosted in their own cloud)? Self-hosted makes bundled mode close to mandatory and changes secret handling entirely. | Phase 6 |
| 3 | **Do enterprise tenants get their own GitHub App**, or share the central one? `config/app.config.ts` currently assumes one App and one `enforcedOrg` (default `Alpha-Explora`). Per-tenant Apps affect installation linking and webhook routing. | Phase 4 |
| 4 | **Does billing belong in a single-tenant install at all?** An enterprise contract is usually invoiced, not PayMongo-checkout'd. `billing` may reduce to entitlements only, and `usage` quotas may become advisory. | Phase 4 |
| 5 | **Supabase or plain Postgres per tenant?** Enterprise customers may require their own managed Postgres. `libs/db` already handles both via `SUPABASE_DB_URL`, but the RLS migrations and Supabase-specific pooling assumptions need a decision. | Phase 0 |
| 6 | **Upgrade policy across tenants** — are all customers held at one release, or is version skew allowed? Skew multiplies the compatibility surface of `platform.v_*` views. | Phase 6 |

Question 4 is the one most likely to change section 2's context map, and
question 2 is the one most likely to change section 7 outright.
