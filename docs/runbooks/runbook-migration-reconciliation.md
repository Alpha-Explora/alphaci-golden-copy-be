---
type: "Playbook"
title: "Migration ledger reconciliation"
description: "Reconcile checked-in migration files with the configured Supabase migration ledger without re-running applied SQL."
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

Use this procedure when migration files and the configured Supabase migration ledger do not describe the same history. The repair marks SQL that is already applied; it does not re-run those migrations.

## Current reconciliation facts

- The migration tree is grouped under six context owners.
- Filename versions were normalized so every migration version is unique.
- Extracted ledger migrations are checked into the migration tree.
- The remaining ledger repair is an operator action against the configured Supabase project, not a local SQL replay.

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
