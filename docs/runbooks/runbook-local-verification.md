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
npm run check:composition-source
npm run check:capability-ledger
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

`npm run db:migrate:selfhost -- --dry-run` lists the same tree in the self-hosted runner's order, with each file's transaction mode and checksum.

## Focused checks

```bash
npm run test:documentation
npm test -- --ci --runInBand tests/architecture/http-boot.spec.ts
npm test -- --ci --runInBand tests/architecture/outbox-scheduler.spec.ts
npm test -- --ci --runInBand tests/architecture/provider-plugin.acceptance.spec.ts
```

## End-to-end suite

`npm run test:e2e` needs Docker. It starts the disposable loopback PostgreSQL
fixture in `tests/integration/database/compose.yaml`, creates a fresh
database, applies every migration, and boots the real application and HTTP
middleware against it. Scenarios sign in through loopback quick login and call
the API. GitHub, CI token, and deployment provisioning ports are recording
fakes, so no provider is contacted. The suite ignores `.env` files and removes
provider credentials from its environment. It refuses a non-loopback database.

To reuse a running loopback PostgreSQL, set `E2E_DATABASE_URL` to its admin
connection; the suite then leaves the container running.

Scenarios that create projects read the central workflow templates from
`TEMPLATE_REPO_PATH` (default `../alphaci-workflow`, a sibling checkout of
`Alpha-Explora/alphaci-workflow`).

Each run writes `artifacts/e2e/<commit>/report.json` with the commit, a dirty
flag, the command, the database image, and each scenario's result. CI runs the
same command in the `End-to-end suite (Postgres fixture)` job, against a pinned
`alphaci-workflow` commit, and uploads the report as `e2e-report` when the job
fails.

## Evidence

Record the commands run, pass/fail result, intentionally skipped integration checks, and any external environment required. A static pass does not prove live PostgreSQL, provider APIs, deployed scheduling, or rollback behavior.
