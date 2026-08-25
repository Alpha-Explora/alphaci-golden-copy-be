# AlphaCI Enterprise Backend — Future State Architecture

**Status:** adopted. This document describes the direction the codebase is
actively moving in, after the split-services topology proposed earlier was
**rejected** in favor of a modular monolith.

## Decision history

An earlier revision of this file proposed splitting into seven deployables
(`apps/` + `libs/` + edge gateway) with per-context database roles and a dual
composition root. That plan was rejected: for this product it bought failure
isolation and independent scaling at a cost (gateway ops, internal JWT, six
pools to size, contract tests doubled) that no current customer signal
justifies.

What survives from that proposal is the **boundary work** — schema ownership,
enforced module boundaries, and hexagonal layering inside each module — which
is identical either way and keeps future extraction possible without treating
extraction as the current goal.

## Current target: progressive hexagonal-clean modular monolith

One NestJS deployable. Modules grouped along domain-ownership lines into six
contexts, layered internally per the backend-architecture skill:

```text
src/
├── kernel/                  # shared cross-cutting infrastructure only
│   ├── db/                  #   DatabaseService + Supabase client
│   ├── events/              #   outbox repository
│   └── auth/                #   session lookup contract
├── common/                  # guards, filters, middleware, config
├── modules/
│   ├── identity-access/     # (future) auth, admin, teams, capabilities
│   ├── projects/            # projects + catalog + workflows + existing-repos
│   ├── pipelines/           # (future) github + ci
│   ├── runtime/             # deployments: targets, env-vars, domains, providers
│   ├── billing/             # (future) subscription + usage
│   └── platform-ops/        # (future) notifications + feedback
└── app.module.ts            # composition root
```

### Layering rules inside a module

```text
presentation → application → domain
                       ↘ ports
infrastructure ───────────┘
```

- `presentation/` — controllers, guards, DTOs. Thin; no business logic.
- `application/` — use-case services and orchestration.
- `domain/` — pure rules; **no framework or vendor imports** (CI-enforced).
- `infrastructure/` — repositories and provider clients.
- `core/` — module-owned shared types and contracts.
- Progressive depth: thin CRUD modules stay flat (level 1); only complex
  workflows earn full layering. No empty layers.
- Ports exist only where 2+ implementations genuinely exist.

## Enforcement (live)

| Gate | Checks | Status |
|------|--------|--------|
| `.dependency-cruiser.cjs` | deep imports across modules, kernel-to-module deps, cycles, deployments domain purity | ✅ CI |
| known-violations baseline | violations may go down, never up | ✅ CI |

## Migration status

| Milestone | State |
|-----------|-------|
| Kernel extraction (`kernel/db`, `kernel/events`, `kernel/auth`) | done |
| Deployments: contracts unified, providers under one infrastructure tree, files layered | done |
| Projects god-file decomposed (service 4,220 to ~2,500 lines; policy/mappers/token/setup/events extracted) | done |
| Module consolidation 19 to 6 contexts | deferred by product decision |

## What was dropped from the old plan

- Turborepo scaffold, `apps/*` packages, edge-gateway service — not needed for
  a single deployable.
- Per-context DB roles (`CTX_DB_ROLE`) as an immediate goal — revisit only if
  cross-schema leakage becomes a demonstrated problem.
- Split/bundled composition roots and tenant manifests — rejected with the
  topology itself.

If a future requirement genuinely needs independent scaling or deployment of
one context, the enforced boundaries make strangler extraction possible — but
that decision starts with evidence, not architecture enthusiasm.
