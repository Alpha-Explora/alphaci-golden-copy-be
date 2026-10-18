---
type: "Architecture Checks"
title: "Architecture check map"
description: "Generated snapshot of source metrics and the repository architecture gates."
tags: [architecture, checks, map, verification]
status: stable
sources:
  - id: "metrics-source"
    resource: "scripts/report-architecture-metrics.cjs"
    title: "Architecture metrics generator"
  - id: "boundary-source"
    resource: ".dependency-cruiser.cjs"
    title: "Authoritative dependency graph configuration"
  - id: "capability-gate"
    resource: "scripts/check-capabilities.cjs"
    title: "Capability registry gate"
  - id: "ci-source"
    resource: ".github/workflows/ci.yml"
    title: "Continuous integration gate"
---

# Architecture check map

This snapshot is generated from the current source tree. It is descriptive evidence; the executable gates remain the commands in the verification table.

## Context metrics

| Context | Source files | Test files | Cross-context imports | Directional pairs | Contract imports | Application imports |
|---|---:|---:|---:|---:|---:|---:|
| `billing` | 21 | 5 | 0 | 0 | 0 | 0 |
| `identity-access` | 148 | 34 | 9 | 5 | 0 | 0 |
| `pipelines` | 86 | 32 | 1 | 1 | 0 | 0 |
| `platform-ops` | 31 | 6 | 0 | 0 | 0 | 0 |
| `projects` | 305 | 115 | 20 | 5 | 0 | 0 |
| `runtime` | 204 | 71 | 10 | 4 | 0 | 0 |

| Total | 795 | 263 | 40 | 15 | 0 | 0 |

Dead in-process adapters measured by the source report: **0**.

## Executable gates

| Gate | Command | Authority |
|---|---|---|
| Type safety | `npm run typecheck` | TypeScript compiler |
| Build | `npm run build` | TypeScript build configuration |
| Lint and tests | `npm run lint` and `npm test -- --ci --runInBand` | ESLint and Jest |
| Dependency boundaries | `npm run boundaries` | dependency-cruiser |
| Application boundaries | `npm run check:application-boundaries` | cross-context contract/application rule checker |
| Provider encapsulation | `npm run check:provider-encapsulation` | provider ownership checker |
| Schema ownership | `npm run check:schema-ownership` | migration and inline SQL checker |
| Capability registry | `npm run check:capabilities` | AppConfig flag ownership, capability dependency, and pack catalog completeness checker |
| Migration order | `npm run db:apply:all -- --dry-run` | migration replay planner |
| OKF bundle | `npm run check:okf` | OKF v0.2 bundle validator |
| Documentation | `npm run check:documentation` | naming, stale-claim, generated-map, and documentation policy checker |

## Limits

Static gates do not prove a live database connection, deployed cron execution, provider API availability, or external rollback. Those checks are covered by the relevant integration and operational runbooks when their environment is configured.
