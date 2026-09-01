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
- [Runbooks](docs/runbooks/index.md) - verification, database, outbox, provisioning, authentication, and performance procedures.
- [Changelog](CHANGELOG.md) - repository-level changes.

The `FLOWCI_*` environment namespace remains a compatibility identifier where it appears in current configuration and generated deployment workflows.

## Development

Install and run the standard verification loop:

```bash
npm ci
npm run typecheck
npm run lint
npm test -- --ci --runInBand
npm run build
npm run check:documentation
```

The architecture gates are available through `npm run boundaries`, `npm run check:application-boundaries`, `npm run check:provider-encapsulation`, and `npm run check:schema-ownership`. See the [local verification runbook](docs/runbooks/runbook-local-verification.md) for the complete sequence and evidence expectations.
