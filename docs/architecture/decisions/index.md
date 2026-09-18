# Architecture decisions

* [ADR-0001: Six-context modular monolith](adr-0001-six-context-modular-monolith.md) - context ownership and one deployable.
* [ADR-0002: Orthogonal product axes](adr-0002-orthogonal-product-axes.md) - independent edition, tenancy, deployment, and flag values.
* [ADR-0003: Composition packs and entitlements](adr-0003-composition-packs-and-entitlements.md) - pack composition and narrowing rules.
* [ADR-0004: Provider and port boundaries](adr-0004-provider-and-port-boundaries.md) - Runtime provider ownership and focused ports.
* [ADR-0005: PostgreSQL outbox delivery](adr-0005-postgresql-outbox-delivery.md) - current event persistence and relay guarantees.
* [ADR-0006: Stack as a declared axis](adr-0006-stack-as-a-declared-axis.md) - catalog-declared stack identity and registry-resolved toolchains.
* [ADR-0007: Runtime composition resolution](adr-0007-runtime-composition-resolution.md) - kernel-owned capability resolution and entitlement separation.
* [ADR-0008: Build profiles and artifact exclusion](adr-0008-build-profiles-and-artifact-exclusion.md) - pack sets per artifact and excluded source.
* [ADR-0009: Client capability policies](adr-0009-client-capability-policies.md) - deny-only per-client narrowing within an edition.
* [ADR-0010: Single authoring source for composition](adr-0010-single-authoring-source-for-composition.md) - one capability record, generated registry, manifests, and pack rows.
* [ADR-0011: Deployment database isolation](adr-0011-deployment-database-isolation.md) - hosted multi-tenancy and Enterprise single-tenancy per deployment/database.
