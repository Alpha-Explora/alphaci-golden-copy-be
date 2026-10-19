---
type: "Playbook"
title: "Migration ledger reconciliation"
description: "Reconcile checked-in migration files with a Supabase project's migration ledger without re-running applied SQL."
tags: [runbook, database, migrations, reconciliation]
status: stable
sources:
  - id: reconciliation-record
    resource: "scripts/apply-all-migrations.mjs"
    title: "Migration replay planner"
  - id: migration-tree
    resource: "supabase/migrations"
    title: "Migration source tree"
---
# Migration ledger reconciliation

## Purpose

Use this procedure when the migration files and a Supabase project's migration ledger do not describe the same history. The repair marks SQL that is already applied; it does not re-run it.

This applies to Supabase-hosted databases only. The self-hosted runner keeps its own ledger, `public.schema_migrations`, with a checksum per file. There, a checksum mismatch means an applied file changed: restore the original file instead of repairing the ledger. See the [database migrations runbook](runbook-database-migrations.md#self-hosted-appliance-plain-postgresql).

## Reconciliation facts

- The migration tree is grouped under six context owners.
- Every migration filename version is unique.
- Migrations that exist only in the ledger are checked into the tree.
- The versions listed below are the ones to mark when the hosted ledger lacks them. Check each with `supabase migration list --linked` first. Marking them is an operator action against the configured project, not a local SQL replay.

## Preconditions

- Confirm the intended Supabase project reference and database target.
- Back up or otherwise protect the database according to the environment policy.
- Review the migration list and confirm that the listed SQL effects are already present.
- Do not use `db:apply:all` to re-run migrations that are already applied but absent from the ledger.

## Ledger repair

Link the CLI to the approved project and mark only verified-applied versions:

```bash
supabase link --project-ref <project-ref>

supabase migration repair --status applied \
  20260622063000 20260702000100 20260712 \
  20260713060000 20260713061000 20260713062000 20260713063000 20260713064000 \
  20260713120000 20260713130000 \
  20260714000000 20260714010000 20260729000000
```

Then inspect the linked list:

```bash
supabase migration list --linked
```

Confirm that every ledger version has one matching file and that no file will be applied a second time.

## Data and security review

- Review the destructive billing catalog migration before using any repair command near billing data.
- Review data migrations independently of schema-only migrations.
- Confirm RLS status and policies for exposed tables. Enabling RLS without policies can deny application access; disabling RLS on exposed tables can create a security issue.
- Record any legacy public-schema tables retained by compatibility migrations.

## Evidence

Capture the project reference, pre-repair list, exact repair command, post-repair list, schema verification query, operator, and result. Never commit credentials or database output containing secrets.
