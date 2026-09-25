---
type: "Playbook"
title: "Local backend verification"
description: "Reproducible local checks for code, architecture, documentation, and migration planning."
tags: [runbook, verification, development]
status: stable
sources:
  - id: package-scripts
    resource: "package.json"
    title: "Repository verification scripts"
  - id: ci-workflow
    resource: ".github/workflows/ci.yml"
    title: "Continuous integration workflow"
---
# Local backend verification

Use this sequence before merging a change that affects source, schemas, providers, events, or documentation.

## Preconditions

- Use Node.js 22 as configured by CI.
- Install the exact lockfile with `npm ci`.
- Provide environment values from `.env.example` when a boot or integration check needs them.
- Do not run database mutation commands against a shared environment without an approved target and rollback plan.

## Entry points

```bash
npm run check    # static gates: docs, generated maps, boundaries, schema, capabilities, migration replay
npm run verify   # typecheck, lint, check, Jest, build-profile conformance (what CI runs)
```

After changing capabilities or architecture, regenerate derived files first with `npm run generate:composition` and `npm run generate:architecture-maps`.

## Focused checks

```bash
npm test -- --ci --runInBand tests/architecture/http-boot.spec.ts
npm test -- --ci --runInBand tests/architecture/outbox-scheduler.spec.ts
npm test -- --ci --runInBand tests/architecture/provider-plugin.acceptance.spec.ts
npm run report:architecture-metrics   # report only; never fails
```

## Evidence

Put the commands run, their result, skipped integration checks, and any external environment in the pull request description. A static pass does not prove live PostgreSQL, provider APIs, deployed scheduling, or rollback behavior; the real-database E2E harness that will cover those is not built yet.
