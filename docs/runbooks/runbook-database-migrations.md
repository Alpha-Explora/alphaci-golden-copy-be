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

For ledger drift, use the [migration reconciliation runbook](runbook-migration-reconciliation.md). For the ownership table, use the generated [schema map](/architecture/schema-ownership.generated.md).
