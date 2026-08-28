---
type: "Playbook"
title: "PostgreSQL outbox relay"
description: "Operate the single scheduled relay for platform.outbox_events with at-least-once delivery."
tags: [runbook, events, outbox, operations]
status: stable
sources:
  - id: repository
    resource: "src/kernel/events/outbox.repository.ts"
    title: "Outbox repository"
  - id: relay
    resource: "src/modules/platform-ops/application/outbox-relay.service.ts"
    title: "Outbox relay service"
  - id: scheduler
    resource: "render.yaml"
    title: "Render scheduler"
---
# PostgreSQL outbox relay

## Current ownership

The active table is `platform.outbox_events`. It has one application relay entrypoint, `scripts/process-outbox.cjs`, and one scheduled Render cron in `render.yaml`. The PostgreSQL advisory lock is a concurrency safety mechanism, not a reason to add another scheduler.

## Registered topics

| Topic | Handler owner |
|---|---|
| `platform.audit.recorded` | `platform-ops` |
| `platform.notification.requested` | `platform-ops` |
| `hierarchy.repository_assignment.grant` | `identity-access` |
| `hierarchy.repository_assignment.revoke` | `identity-access` |

Rows outside the registered topic and handler set must not be acknowledged by the relay. The topic registry and dispatcher fail closed for unregistered topics.

## Delivery semantics

- Critical hierarchy state changes use `publishInTransaction` so the state mutation and queue row commit or roll back together.
- Audit and notification event writes use explicit best-effort methods after the business mutation has committed.
- Pending rows are selected by `created_at`, then `id`, under the advisory lock.
- Successful processing sets `status = 'published'` and `published_at`.
- Handler failures increment `attempts`, set `available_at`, and preserve an error message.
- Rows reaching `OUTBOX_MAX_ATTEMPTS` are set to `quarantined`.
- Delivery is at-least-once. Handlers must tolerate a repeated delivery after a process interruption.

## Environment

The Render cron uses the same database and application configuration needed to construct `AppModule`. Relevant relay values are:

```text
OUTBOX_BATCH_SIZE=50
OUTBOX_MAX_ATTEMPTS=5
OUTBOX_RETRY_DELAY_SECONDS=60
SUPABASE_DB_URL=<configured database URL>
SUPABASE_DB_CA_CERT=<configured CA certificate when required>
```

Secret values are configured in the deployment environment, never committed to this repository.

## Manual execution

Build and run once against an approved configured database:

```bash
npm run process:outbox
```

The command prints the number of rows processed and exits non-zero when application startup or relay persistence fails. Do not run a second copy concurrently as an operational workaround; inspect the scheduler, advisory lock, database connectivity, and quarantine state first.

## Investigation checklist

1. Check the Render cron execution log for startup or database errors.
2. Inspect pending, retrying, and quarantined rows in `platform.outbox_events` using an approved read-only database session.
3. Confirm the topic is in `src/kernel/events/outbox-topics.ts` and has exactly one dispatcher handler.
4. Confirm downstream side effects are idempotent before replaying a quarantined row.
5. Record the row IDs, topic, error, action, and verification result.

Use the [event map](/architecture/events-map.generated.md) and [outbox decision](/architecture/decisions/adr-0005-postgresql-outbox-delivery.md) as the contract.
