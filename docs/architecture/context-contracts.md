---
type: "Architecture Contract Register"
title: "Current context contracts"
description: "Current public indexes, serialisable ports, and directional edges between AlphaCI bounded contexts."
tags: [architecture, contracts, boundaries]
status: stable
sources:
  - id: context-ports
    resource: "src/kernel/ports"
    title: "Focused kernel ports"
  - id: boundary-gate
    resource: "scripts/check-application-boundaries.cjs"
    title: "Application boundary checker"
  - id: dependency-graph
    resource: ".dependency-cruiser.cjs"
    title: "Dependency graph configuration"
---
# Current context contracts

This register describes the current in-process boundaries. A context index or port is a dependency-inversion surface inside the one deployable; it is not a network endpoint.

## Contract rules

- `contracts/` and port files contain serialisable types and do not import Nest, database clients, or vendor SDKs.
- Production context code does not import another context's concrete service, repository, DTO, or provider implementation.
- A focused port is used for a real inversion or optional integration. Same-process reads may use the owning context's public index.
- Nest feature-module imports belong to composition roots and are not application-level contracts.
- Provider contracts and registries belong to Runtime. Provider adapters are not context boundaries.

## Current directional edges

| Source | Target | Current contract surface | Current use |
|---|---|---|---|
| `identity-access` | `projects` | `ProjectLookupPort`, project-link composition | hierarchy authorization and project references |
| `identity-access` | `pipelines` | public index and GitHub/CI contracts | repository access and CI composition |
| `identity-access` | `billing` | billing public index | subscription and quota checks |
| `identity-access` | `platform-ops` | kernel audit and notification publishers | observability and user notifications |
| `identity-access` | `runtime` | Runtime public index and catalog port | capability and target composition |
| `projects` | `pipelines` | public index and CI contracts | workflow and CI composition |
| `projects` | `runtime` | deployment runtime contracts and focused tokens | provisioning, history, drift, and targets |
| `projects` | `billing` | billing public index | quota checks |
| `projects` | `platform-ops` | kernel audit and notification publishers | observability and notifications |
| `projects` | `identity-access` | public indexes and project-link contract | authorization and references |
| `runtime` | `identity-access` | workspace contract | workspace access checks |
| `runtime` | `pipelines` | public index | GitHub and CI composition |
| `runtime` | `billing` | public index and quota port | usage and quota policy |
| `runtime` | `platform-ops` | kernel audit and notification publishers | observability and notifications |
| `pipelines` | `platform-ops` | kernel audit publisher | observability |

The current source metric reports 15 directional pairs. The generated [context map](/architecture/context-map.generated.md) records file-level counts; the dependency graph gate is authoritative for violations.

## Focused ports

The reusable ports in `src/kernel/ports/` cover GitHub, GitHub team roles, and CI stage results; workspaces, app roles, and platform administration; project lookup, links, lifecycle, visibility, and requirements readiness; delivery-project overview, repository provisioning, and data cleanup; quota and subscription bootstrap; workflow generation, workflow and toolchain fragments; Playwright live runs and visual regression; audit and feedback; and the provider catalog, deployment runtime, and on-prem host assignment. They keep consumers dependent on serialisable inputs and outputs while the current module graph remains in-process.

## Current event contract

The kernel owns the outbox topic registry and serialisable event payload validation. Producers write to `platform.outbox_events`; context-owned handlers register with `OutboxDispatcher`. The [event map](/architecture/events-map.generated.md) is the source for current topics, owners, and delivery semantics.

## Current database transition seams

Some repositories read tables owned by another context because the current database still contains shared relationships and compatibility tables. Each such reference is listed exactly in the schema gate and generated [schema ownership map](/architecture/schema-ownership.generated.md). The allowance is not permission to add another reference.

## Verification

Run `npm run boundaries`, `npm run check:application-boundaries`, `npm run check:schema-ownership`, and `npm run report:architecture-metrics -- --json` when reviewing a boundary change. The [architecture check map](/architecture/architecture-checks.generated.md) links the complete gate set.
