---
type: "Architecture Map"
title: "Bounded context map"
description: "Generated ownership map for the six current NestJS bounded contexts."
tags: [architecture, map, ownership]
status: stable
sources:
  - id: "context-source"
    resource: "src/modules"
    title: "Current context source tree"
  - id: "metrics-source"
    resource: "scripts/report-architecture-metrics.cjs"
    title: "Architecture metrics generator"
---

# Bounded context map

This map is generated from the current source tree and architecture metrics. It records ownership in the one NestJS deployable; it does not create additional deployables or alter runtime behavior.

## Contexts

| Context | Owns | Public boundary | Owned schemas | Measured source/test files |
|---|---|---|---|---|
| `identity-access` | authentication, administration, capabilities, workspaces, hierarchy, and repository access policy | `src/modules/identity-access/index.ts` | `identity`, `orgs`, `hierarchy` | 140 source files / 30 tests |
| `projects` | project lifecycle, catalog, workflows, existing repositories, and project read models | `src/modules/projects/index.ts` | `projects`, `workflow` | 210 source files / 69 tests |
| `pipelines` | GitHub integration, CI token lifecycle, and CI report ingestion | `src/modules/pipelines/index.ts` | `github_app`, `ci`, `workflow` | 48 source files / 14 tests |
| `runtime` | deployment targets, environment metadata, domains, provider connections, provider adapters, and deployment history | `src/modules/runtime/index.ts` | `runtime`, `env_provisioning`, `runtime_deployments`, `runtime_domains`, `runtime_secrets`, `gcp_operations` | 151 source files / 55 tests |
| `billing` | subscriptions, usage, and quota policy | `src/modules/billing/index.ts` | `billing`, `usage`, `billing_lifecycle` | 21 source files / 5 tests |
| `platform-ops` | audit, notifications, feedback, and outbox consumers | `src/modules/platform-ops/index.ts` | `platform`, `audit`, `notifications`, `support` | 29 source files / 4 tests |

The technical kernel at `src/kernel/` is shared infrastructure for database access, configuration, HTTP concerns, session contracts, event persistence, and focused ports. It has no business-context ownership.

## Boundary rule

Production context callers use a context public index, a serialisable contract, or an injected focused port. Context composition roots may import Nest feature modules to assemble the current in-process graph. Dependency-cruiser remains the authoritative import graph; this map is an ownership and trend view.

## Regeneration

Run `npm run generate:architecture-maps`. CI uses `npm run generate:architecture-maps -- --check` to reject stale output.
