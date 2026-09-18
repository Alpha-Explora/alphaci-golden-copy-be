---
type: "Playbook"
title: "Deployment database boundaries"
description: "Provision and verify hosted multi-tenancy and Enterprise dedicated database boundaries."
tags: [runbook, database, tenancy, deployment]
status: draft
sources:
  - id: isolation-decision
    resource: "/architecture/decisions/adr-0011-deployment-database-isolation.md"
    title: "Deployment database isolation decision"
  - id: tenancy-migration
    resource: "supabase/migrations/identity-access/20260918000000_tenancy_kernel.sql"
    title: "Additive tenancy migration"
  - id: backfill-command
    resource: "scripts/backfill-tenant-scope.ts"
    title: "Explicit tenant-scope backfill command"
---
# Deployment database boundaries

## Topology

- Hosted SaaS and Education may use one shared hosted database. Every tenant-owned request must carry a membership-validated tenant context.
- Enterprise uses one dedicated cloud or on-prem database per deployment/customer. The connection target is the physical boundary; the initial implementation permits one active tenant there.
- Local and staging environments use separate non-production database targets and explicit seed mappings.

The current rollout scopes the workspace and provisioned-project roots and the
covered request-facing descendants in hierarchy, runtime, project-child
workflows, CI reports/token status, audit project reads, and project-scoped
usage counters. Bearer-authenticated CI ingestion and webhook reconciliation
are explicit deployment-global worker paths, not session-scoped reads, but
tenant-owned writes must carry the validated project/tenant scope. Identity
directory, platform administration, account-level billing, and other
documented global operations retain their own authorization boundaries.

The authentication guard requires tenant context by default for protected
requests. Explicit global routes opt out at the controller or handler level;
do not add the opt-out to a route that reads or writes tenant-owned data.

Rows with a null `tenant_id` are intentionally invisible to tenant-scoped
queries until an operator performs an explicit backfill.

Do not create edition schemas, client-specific copied tables, or a database
selection branch based on `ALPHACI_EDITION`. A client policy changes allowed
capabilities/UI only.

## Provisioning sequence

1. Create or select the correct database target and record its hostname, environment, deployment profile, and owner.
2. Apply the migration preflight and replay dry run.
3. Apply the tenancy migration and verify the migration ledger.
4. Run `npm run db:provision-tenant` without `--apply` to review the operator-supplied tenant UUID, name, kind, deployment mode, and initial membership. Re-run with `--apply` only after checking the printed hostname; production writes also require `--confirm-production`.
5. Run `db:backfill-tenant-scope` without `--apply`; review selected workspace/project IDs and counts.
6. Apply only the reviewed mapping. Keep legacy rows unscoped when identity cannot be proven.
7. Start the service with `ALPHACI_BUILD_PROFILE=hosted` for SaaS/EDU or `enterprise` for Enterprise, and select the edition pack independently.

## Verification evidence

Record:

- the database hostname/project and whether it is hosted, dedicated cloud, on-prem, local, or staging;
- the applied migration names and ledger parity;
- the tenant UUID, deployment profile, membership owner, and backfill IDs/counts;
- negative checks showing that a user or project from another tenant is not returned;
- for Enterprise, proof that the database contains exactly one active tenant.

A green unit suite or a local dry run does not prove that two customer deployments
are connected to different databases. That boundary requires deployment-level
evidence.
