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

## Fast documentation loop

```bash
npm run generate:architecture-maps
npm run check:okf
npm run check:capabilities
npm run check:documentation
git diff --check
```

## Full local loop

```bash
npm run typecheck
npm run lint
npm test -- --ci --runInBand
npm run build
npm run boundaries
npm run check:application-boundaries
npm run check:provider-encapsulation
npm run check:schema-ownership
npm run check:capabilities
npm run db:apply:all -- --dry-run
npm run check:documentation
git diff --check
```

## Focused checks

```bash
npm run test:documentation
npm test -- --ci --runInBand tests/architecture/http-boot.spec.ts
npm test -- --ci --runInBand tests/architecture/outbox-scheduler.spec.ts
npm test -- --ci --runInBand tests/architecture/provider-plugin.acceptance.spec.ts
```

## Evidence

Record the commands run, pass/fail result, intentionally skipped integration checks, and any external environment required. A static pass does not prove live PostgreSQL, provider APIs, deployed scheduling, or rollback behavior.
