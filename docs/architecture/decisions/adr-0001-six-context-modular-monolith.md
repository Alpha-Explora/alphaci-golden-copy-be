---
type: "Decision"
title: "Six-context modular monolith"
description: "Keep the backend as one NestJS deployable organized around six bounded contexts."
tags: [architecture, decision, contexts]
status: stable
timestamp: "2026-08-28T00:00:00Z"
sources:
  - id: application-composition
    resource: "src/app.module.ts"
    title: "Current context composition"
  - id: context-map
    resource: "/architecture/context-map.generated.md"
    title: "Generated bounded context map"
---
# ADR-0001: Six-context modular monolith

**Decision date:** 2026-08-28
**Decision status:** Accepted
**Scope:** AlphaCI backend application and migration ownership

## Decision

The backend is organized as six bounded contexts in one NestJS deployable:

1. `identity-access` - authentication, administration, capabilities, workspaces, hierarchy, and repository access policy.
2. `projects` - project lifecycle, catalog, workflows, existing repositories, and project read models.
3. `pipelines` - GitHub integration, CI token lifecycle, and CI report ingestion.
4. `runtime` - deployment targets, environment metadata, domains, provider connections, provider adapters, and deployment history.
5. `billing` - subscriptions, usage, and quota policy.
6. `platform-ops` - audit, notifications, feedback, and outbox consumers.

`src/app.module.ts` imports the six context roots. Technical infrastructure remains in `src/kernel/` and has no business-context ownership.

## Rejected alternatives

- A seven-context split that creates separate top-level ownership for deployment providers was rejected; providers remain Runtime plugins.
- A feature-module list in the application root was rejected; feature modules are composed behind context roots.
- A shared business module was rejected; cross-context reuse must use a public index, serialisable contract, or focused port.

## Consequences

- Context ownership and migration ownership are visible in the source tree.
- The application remains one process with the same public HTTP routes, DTO compatibility, and product workflows. Internal reliability changes are explicit: the outbox now uses leased claims and the migration tree includes the supporting columns and rollback procedures documented in the [outbox decision](/architecture/decisions/adr-0005-postgresql-outbox-delivery.md).
- Nest composition imports can connect contexts, but application code must not reach through another context's private implementation.
- The [context contract register](/architecture/context-contracts.md) and [architecture checks](/architecture/architecture-checks.generated.md) are part of the review surface.

## Verification

`npm run boundaries`, `npm run check:application-boundaries`, `npm run check:schema-ownership`, and the context-root architecture test verify this decision.
