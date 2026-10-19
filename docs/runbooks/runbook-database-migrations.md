---
type: "Playbook"
title: "Database migrations"
description: "Validate ownership and replay order, then apply the migration tree to a Supabase database or to the self-hosted PostgreSQL database."
tags: [runbook, database, migrations]
status: stable
sources:
  - id: migration-planner
    resource: "scripts/apply-all-migrations.mjs"
    title: "Migration replay planner"
  - id: selfhost-runner
    resource: "src/scripts/selfhost-migrations.ts"
    title: "Self-hosted migration runner"
  - id: ownership-gate
    resource: "scripts/check-schema-ownership.cjs"
    title: "Schema ownership gate"
  - id: migration-tree
    resource: "supabase/migrations"
    title: "Migration source tree"
---
# Database migrations

The migration tree is `supabase/migrations/<owner>/*.sql`, one directory per context owner. Both runners discover every file recursively and apply them in one global order, sorted by filename. Migrations never run at application startup.

## Preflight

Run the static checks before any database change:

```bash
npm run check:schema-ownership
npm run db:apply:all -- --dry-run
```

The ownership check covers migration SQL and repository inline SQL. The dry run lists the replay order and touches nothing.

## Review rules

- A migration belongs under the context that owns the schema it creates or changes.
- Existing cross-schema references are exact, reviewed entries in the ownership gate. A new one needs an ownership decision and a precise gate entry, not a whole-file exemption.
- Filename versions are unique across the whole tree.
- Migrations are idempotent, so a rerun is a normal recovery step.
- Review destructive data operations and rollback SQL separately from ordering.

## Self-hosted appliance (plain PostgreSQL)

The appliance's `migrate` service runs `node dist/src/scripts/migrate-selfhost.js` before `api` on every `docker compose up`. To run it by hand from the install directory:

```bash
docker compose run --rm migrate                                              # apply pending migrations
docker compose run --rm migrate node dist/src/scripts/migrate-selfhost.js --dry-run   # list them
./alphaci-ctl doctor                                                         # "migrations are at head"
```

Outside the appliance, run it from a checkout against any PostgreSQL 16 database:

```bash
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<db> npm run db:migrate:selfhost
npm run db:migrate:selfhost -- --dry-run
```

The runner reads `DATABASE_URL` (or `DATABASE_URL_FILE`, or `SUPABASE_DB_URL`), and `DATABASE_CA_CERT` for TLS. Loopback hosts connect without TLS; other hosts use TLS unless the URL sets `sslmode=disable`. A run:

1. Takes a session advisory lock, so two starting containers cannot interleave.
2. Creates the `anon` and `authenticated` roles if they are missing (`deploy/selfhost/postgres-init/00-roles.sql`).
3. Creates the ledger `public.schema_migrations(version, applied_at, checksum)`, keyed by full filename.
4. Stops before applying anything if an applied file's checksum changed.
5. Applies each pending migration in its own transaction with its ledger row. A file with its own `BEGIN`, or a non-transactional statement, runs unwrapped, and the runner warns when it starts one; a failure there can leave partial effects.

It stops at the first failure. Exit codes: 0 success, 1 migration or connection failure, 2 configuration error.

## Supabase (hosted backend)

`db:apply:all` applies every migration in order through `scripts/apply-migrations.ts`, each in its own transaction. It reads `SUPABASE_DB_URL` from `.env`: the direct connection on port 5432, not the 6543 transaction pooler.

```bash
npm run db:apply:all
npm run db:apply:all -- --from <filename>.sql   # resume from one file
npm run db:apply -- <filename>.sql ...          # apply named files only
```

It keeps no ledger of its own and stops at the first failure. Use the Supabase CLI when the linked project's ledger needs inspection or repair; see the [migration reconciliation runbook](runbook-migration-reconciliation.md). Record the planned order, the applied result, and a verification query.

## Rollback and evidence

A clean dry run does not show that a rollback is safe. Review the matching `supabase/rollbacks/` file, data loss, foreign keys, RLS, and external consumers. Rollbacks are not applied by either runner. Record the migration names, database target, operator, start and end time, result, and any follow-up reconciliation.

The rollback for `20260824000000_branch_scoped_env_vars.sql` fails closed for any preview row, because the old schema cannot keep preview branch identity. Do not remove that guard or add automatic winner selection: resolve the preview data through an approved backup or re-provisioning action first.

On the appliance, a migration is undone by restoring the backup taken before the upgrade; see the [self-hosted install runbook](runbook-selfhost-install.md#upgrade).

For the ownership table, use the generated [schema map](/architecture/schema-ownership.generated.md).
