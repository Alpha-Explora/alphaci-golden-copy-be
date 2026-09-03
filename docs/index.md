---
okf_version: "0.2"
---
# AlphaCI backend knowledge bundle

This bundle describes the current AlphaCI backend as one NestJS deployable. It is organized for progressive disclosure: start with the [constitution](constitution.md), then use the current architecture, capability, pack, and runbook sections. The frontend repository keeps a matching current-state bundle that snapshots this catalog and records the screens that consume it.

## Foundations

* [Executive and implementation report](executive/) - self-contained current platform position and Enterprise-first implementation program.
* [Constitution](constitution.md) - executable current-state invariants.
* [Architecture](architecture/) - context ownership, contracts, events, providers, routes, schemas, checks, and decisions.
* [Capabilities](capabilities/) - capability contract, current registry, and generated matrix.
* [Packs](packs/) - comparable SaaS, EDU, and Enterprise composition references.
* [Runbooks](runbooks/) - verification, migrations, outbox, provisioning, authentication, and performance procedures.

## Maintenance

* [Bundle update log](log.md) - OKF documentation-bundle history.
* Repository change history is recorded in the root `CHANGELOG.md`.

The bundle uses OKF v0.2 Markdown and YAML frontmatter. `index.md` files are directory listings and `log.md` is update history; all other Markdown files are typed concepts.
