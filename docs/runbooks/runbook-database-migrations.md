---
type: "Playbook"
title: "Database migrations"
description: "Validate ownership and replay order before applying the current Supabase migrations."
tags: [runbook, database, migrations]
status: stable
sources:
  - id: migration-planner
    resource: "scripts/apply-all-migrations.mjs"
    title: "Migration replay planner"
  - id: ownership-gate
    resource: "scripts/check-schema-ownership.cjs"
    title: "Schema ownership gate"
  - id: migration-tree
    resource: "supabase/migrations"
    title: "Migration source tree"
---
# Database migrations

## Preflight

Run the static checks before any database mutation:

```bash
npm run check:schema-ownership
npm run db:apply:all -- --dry-run
```

The ownership check covers migration SQL and repository inline SQL. The replay planner recursively discovers the six owner directories and sorts timestamp-prefixed filenames globally.

## Tenant-scope expansion

The `20260918000000_tenancy_kernel.sql` migration is additive. It creates the
`tenancy` schema and adds nullable `tenant_id` columns to workspace/project
roots. The `20260918000010_tenant_scope_extensions.sql` migration adds the same
nullable scope to workflow generations and provider connections, and
`20260918000020_ci_run_reports_tenant_scope.sql` adds it to CI reports while
replacing the repository-name-only upsert key. These migrations deliberately
do not guess ownership for existing rows.

After the migration is applied, backfill selected rows only after reviewing a
dry run against the printed database hostname:

```bash
npm run db:backfill-tenant-scope -- --tenant-id <uuid> --deployment-mode hosted --workspace-id <uuid>
npm run db:backfill-tenant-scope -- --tenant-id <uuid> --deployment-mode hosted --workspace-id <uuid> --project-id <uuid> --apply
npm run db:backfill-tenant-scope -- --tenant-id <uuid> --deployment-mode hosted --workflow-generation-id <uuid> --provider-connection-id <uuid> --apply
npm run db:backfill-tenant-scope -- --tenant-id <uuid> --deployment-mode hosted --ci-run-report-id <uuid> --apply
```

Enterprise still requires a dedicated cloud or on-prem database and one active
tenant; the command requires explicit row IDs even there. A dry-run result and
the selected IDs are part of the migration evidence. The backfill validates
active tenant membership and rejects a selected project whose workspace is
foreign or unscoped unless that workspace is selected explicitly.

Provision the tenant and initial membership before backfill:

```bash
npm run db:provision-tenant -- --tenant-id <uuid> --name "Example tenant" --slug example-tenant --kind customer --deployment-mode hosted --user-id <uuid>
npm run db:provision-tenant -- --tenant-id <uuid> --name "Example tenant" --slug example-tenant --kind customer --deployment-mode hosted --user-id <uuid> --apply
```

The first command is dry-run by default. Enterprise writes must target the
dedicated database and be verified with `--confirm-production` when
`NODE_ENV=production`.

## Review rules

- A migration belongs under the context that owns the schema it creates or changes.
- Existing cross-schema references are exact, reviewed transition entries in the ownership gate.
- A new cross-schema reference requires an ownership decision and a precise gate entry; do not add a whole-file exemption.
- Migration filenames must have unique timestamp versions across the complete tree.
- Review destructive data operations and rollback SQL separately from ordering.

## Apply

For an approved configured database, use the repository migration tooling with the required environment values:

```bash
npm run db:apply:all
```

Use the repository's normal Supabase CLI procedure when the linked environment requires ledger inspection or repair. Capture the planned order, applied result, and database verification query.

## Rollback and evidence

Do not infer that a rollback is safe from a clean dry-run. Review the matching `supabase/rollbacks/` file, data-loss behavior, foreign keys, RLS, and external consumers. Record the migration names, database target, operator, start/end time, result, and any follow-up reconciliation.

The rollback for `20260824000000_branch_scoped_env_vars.sql` fails closed for
any preview row because the old schema cannot preserve preview branch identity.
Do not remove that guard or add an automatic winner-selection step: take an
approved backup/re-provisioning action, then retry the rollback only after the
preview data has been resolved.

For ledger drift, use the [migration reconciliation runbook](runbook-migration-reconciliation.md). For the ownership table, use the generated [schema map](/architecture/schema-ownership.generated.md).
