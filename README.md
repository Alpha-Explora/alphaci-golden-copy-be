# AlphaCI backend

This repository contains the current AlphaCI backend: one NestJS deployable with six bounded contexts, a technical kernel, Runtime provider plugins, PostgreSQL/Supabase persistence, and a PostgreSQL outbox relay.

## Documentation

The canonical documentation bundle is the OKF v0.2 tree under [`docs/`](docs/index.md):

- [Constitution](docs/constitution.md) - current invariants and update rules.
- [Executive and implementation report](docs/executive/golden-copy-executive-report.md) - self-contained current position and Enterprise-first implementation program.
- [Current architecture](docs/architecture/current-architecture.md) - source and runtime composition.
- [Context contracts](docs/architecture/context-contracts.md) - public boundaries and focused ports.
- [Event map](docs/architecture/events-map.generated.md) - active outbox topics and delivery path.
- [Provider map](docs/architecture/provider-map.generated.md) - current Runtime providers.
- [Capability contract](docs/capabilities/capability-contract.md) - capability vocabulary and narrowing rules.
- [Composition packs](docs/packs/index.md) - comparable SaaS, EDU, and Enterprise references.
- [Runbooks](docs/runbooks/index.md) - self-hosted install, upgrade and backup, migrations, on-prem hosts, outbox, provisioning, authentication, and verification procedures.
- [Changelog](CHANGELOG.md) - repository-level changes.

The `FLOWCI_*` environment namespace remains a compatibility identifier where it appears in current configuration and generated deployment workflows.

## Development

Use Node.js 22, as CI does. Copy `.env.example` to `.env` (or `.env.local`, read first) and fill in the values the composition needs; each entry documents its sensitivity. Pipeline generation reads the central workflow templates from `TEMPLATE_REPO_PATH` (default `../alphaci-workflow`, a sibling checkout of `Alpha-Explora/alphaci-workflow`).

Install and run the standard verification loop:

```bash
npm ci
npm run typecheck
npm run lint
npm test -- --ci --runInBand
npm run build
npm run check:documentation
```

The architecture gates are available through `npm run boundaries`, `npm run check:application-boundaries`, `npm run check:provider-encapsulation`, `npm run check:schema-ownership`, and `npm run check:capabilities`. `npm run test:e2e` runs the end-to-end suite against a disposable PostgreSQL container and needs Docker. See the [local verification runbook](docs/runbooks/runbook-local-verification.md) for the complete sequence and evidence expectations.

Apply the migrations to the configured database with `npm run db:apply:all` (Supabase, `SUPABASE_DB_URL`) or `npm run db:migrate:selfhost` (plain PostgreSQL, `DATABASE_URL`). See the [database migrations runbook](docs/runbooks/runbook-database-migrations.md).

Run a composition locally with a paired build profile and edition:

```powershell
npm run start:saas
npm run start:edu
npm run start:enterprise
npm run start:enterprise-client
```

These development commands run `nest start --watch` on port 4000 (`PORT`). The first three select
the SaaS, EDU, and full Enterprise compositions; `start:enterprise-client`
also selects the declared `st-peter` Enterprise client policy. Environment
presets for deployment are in `deploy/env/`.

## Deployment

- Hosted service: the `Dockerfile` image runs on Render, with the outbox cron in `render.yaml`.
- Self-hosted: the same image runs in the Docker Compose appliance under `deploy/selfhost/`. Start with the [self-hosted install runbook](docs/runbooks/runbook-selfhost-install.md).
- On-prem hosts: the agent under `deploy/onprem/` runs project deployments on customer machines. See the [on-prem host setup runbook](docs/runbooks/runbook-onprem-host-setup.md).
