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
* [ADR-0011: Member directory sources](adr-0011-member-directory-sources.md) - one per-deployment directory decides who may join a workspace, served by a public API.
* [ADR-0012: Configurable deployment targets](adr-0012-configurable-deployment-targets.md) - proposed: provider per project slot and branch; the first planned mix uses Vercel/Render for `dev` and `uat`, and customer-hosted Compose for `main`.
* [ADR-0013: QA verification runs](adr-0013-qa-verification-runs.md) - QA Team persona, commit-keyed snapshotted runs, server-enforced sign-off with a frozen report, and automated results shown beside manual verdicts.
* [ADR-0014: Project requirements](adr-0014-project-requirements.md) - requirements owned by a Project, developer Progress and QA Verification as separate tracks, one QA run per Project, and a per-Project merge-to-main gate. Supersedes the per-repository parts of ADR-0013.
