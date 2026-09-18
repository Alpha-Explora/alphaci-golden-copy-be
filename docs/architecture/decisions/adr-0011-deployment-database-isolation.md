---
type: "Decision"
title: "Deployment database isolation"
description: "Define hosted multi-tenancy and Enterprise single-tenancy per deployment/database."
tags: [architecture, decision, database, tenancy, deployment]
status: stable
timestamp: "2026-09-18T00:00:00Z"
sources:
  - id: tenancy-migration
    resource: "supabase/migrations/identity-access/20260918000000_tenancy_kernel.sql"
    title: "Additive tenancy migration"
  - id: tenant-context
    resource: "src/kernel/tenancy/tenant-context.port.ts"
    title: "Validated tenant context contract"
---
# ADR-0011: Deployment database isolation

**Decision date:** 2026-09-18
**Decision status:** Accepted
**Scope:** Database topology, tenancy boundaries, and tenant context

## Decision

The Golden Copy uses two physical deployment modes:

| Build profile | Database topology | Tenant rule |
|---|---|---|
| `hosted` | A hosted database may serve multiple customers | SaaS and Education tenants are isolated by validated tenant context in the shared database |
| `enterprise` | One dedicated cloud or on-prem database per deployment | The deployment contains one active tenant; the database connection is the physical boundary |

`ALPHACI_EDITION` selects a product pack. It does not select a PostgreSQL schema or a copied table set. Client policy can narrow Enterprise capabilities and UI behavior, but it does not create a database boundary.

The first implementation does not support multiple Enterprise customers inside one Enterprise database. That is a possible later extension only after an explicit shared-Enterprise authorization and operations decision.

The canonical vocabulary is:

- `deployment`: one running artifact and its configured database target;
- `tenant`: the customer or institution ownership boundary inside a hosted database, or the single owner of an Enterprise database;
- `workspace`: a team-level product root belonging to one tenant;
- `tenant_unit`: an optional institution hierarchy such as a campus or lab;
- `client_policy`: an Enterprise deny-only capability/UI narrowing document.

## Migration and authorization rules

- Tenancy is owned by the existing `identity-access` bounded context; it is not a new business context yet.
- The tenancy migration is additive. Legacy workspace and project rows stay nullable until an operator supplies an explicit mapping.
- Backfill never infers ownership from edition, email, row order, or database location. The backfill command supports dry-run first and explicit row IDs.
- Authenticated requests resolve a membership-validated `TenantContext` before tenant-owned repositories run. A session tenant value is a selector, not proof of access.
- Global authenticated operations (for example `/auth/me`, account lifecycle, account-level billing, feedback, GitHub account integration, and catalog reads) explicitly opt out of tenant-context resolution. This is an authentication-only opt-out, not permission to access tenant-owned repositories.
- The request-facing workspace and provisioned-project roots, plus their covered descendants in hierarchy, runtime, project-child workflows, CI reports/token status, audit project reads, and project-scoped usage counters, carry the validated context. Explicit deployment-global worker paths (for example bearer-authenticated CI report ingestion and webhook reconciliation) are separate at the request-authentication boundary but must write or resolve an explicit tenant/project scope before persisting tenant-owned data. Identity-directory, platform-admin, account-level billing, and other explicitly global operations remain global by design and require their existing authorization boundary.
- Legacy rows with `tenant_id IS NULL` are excluded from tenant-scoped reads until an operator performs an explicit backfill; a passing local suite does not prove those rows have been classified.
- Billing is independent. Enterprise can remain manually entitled or billing-disabled without weakening tenant isolation.

## Rejected alternatives

- Creating `saas`, `edu`, or `enterprise` PostgreSQL schemas was rejected because edition is composition, not persistence topology.
- Copying the schema per Enterprise client was rejected because the deployment/database is already the initial Enterprise boundary.
- Treating a client policy as a tenant or database selector was rejected because it conflates UI/capability narrowing with data isolation.
- Silent whole-database backfill was rejected because an old database may contain mixed or unclassified rows.

## Consequences

Hosted SaaS and Education can share the operational platform while covered request paths carry validated tenant scope. Enterprise provisioning requires a dedicated database target and exactly one active tenant. A shared Enterprise deployment, tenant-level RLS policy expansion, and tenant partitioning remain future decisions rather than implicit behavior.

## Verification

The additive migration, schema-ownership gate, explicit backfill service, tenant-context tests, and workspace/project negative-scope tests are the first verification surface. Deployment-level evidence still requires checking the actual target database and migration ledger; a passing local suite is not proof of customer isolation.
