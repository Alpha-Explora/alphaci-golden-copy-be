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

The active table is `platform.outbox_events`. It has one application relay entrypoint, `scripts/process-outbox.cjs`, and one scheduled Render cron in `render.yaml`. The relay uses short row-claim transactions and leases, so a slow provider call does not hold a database connection or a process-wide lock. Do not add a second scheduler for this table.

## Registered topics

| Topic | Handler owner |
|---|---|
| `platform.audit.recorded` | `platform-ops` |
| `platform.notification.requested` | `platform-ops` |
| `hierarchy.repository_assignment.grant` | `identity-access` |
| `hierarchy.repository_assignment.revoke` | `identity-access` |

Rows outside the registered topic and handler set must not be acknowledged by the relay. The topic registry and dispatcher fail closed for unregistered topics.

## In-process delivery

The API process also runs `OutboxRelayWorker` on a timer (`OUTBOX_RELAY_INTERVAL_MS`, default 15 seconds, `0` turns it off). It always delivers the two `platform.*` topics. It additionally delivers the two `hierarchy.repository_assignment.*` topics only when the API process itself has `HIERARCHY_GITHUB_SYNC_MODE=live`, because those handlers add and remove people from GitHub teams. With the mode `stub` or unset, hierarchy jobs are left to the Render cron and the manual command.

The worker and the cron may run at the same time: every pass claims rows through the same lease with `FOR UPDATE SKIP LOCKED`, so a job is never delivered by two runners at once. The cron stays as the fallback for the case where the API process is down or the worker is switched off.

## Delivery semantics

- Critical hierarchy state changes use `publishInTransaction` so the state mutation and queue row commit or roll back together.
- Audit and notification event writes use explicit best-effort methods after the business mutation has committed.
- Pending rows are selected by `created_at`, then `id`, with `FOR UPDATE SKIP LOCKED` and a short lease transaction.
- A claimed row remains pending while its `lease_expires_at` is active. An expired lease can be reclaimed by a later run.
- A lease token must match before an acknowledgement, retry, or quarantine update is accepted; a late worker cannot overwrite a newer claim.
- Successful processing sets `status = 'published'` and `published_at`.
- Handler failures increment `attempts`, set `available_at`, and preserve an error message.
- Rows reaching `OUTBOX_MAX_ATTEMPTS` are set to `quarantined`.
- The relay stops waiting for a handler after `OUTBOX_HANDLER_TIMEOUT_MS`; the handler is then retried according to the normal failure policy.
- `OUTBOX_LEASE_SECONDS` must be greater than `OUTBOX_HANDLER_TIMEOUT_MS / 1000`; the relay fails closed when the effective values violate this invariant.
- Delivery is at-least-once. Handlers must tolerate a repeated delivery after a process interruption, lease expiry, or acknowledgement failure.

## Environment

The Render cron uses the same database and application configuration needed to construct `AppModule`. Relevant relay values are:

```text
OUTBOX_BATCH_SIZE=50
OUTBOX_MAX_ATTEMPTS=5
OUTBOX_RETRY_DELAY_SECONDS=60
OUTBOX_LEASE_SECONDS=300
OUTBOX_HANDLER_TIMEOUT_MS=120000
HIERARCHY_GITHUB_SYNC_MODE=live|stub
SUPABASE_DB_URL=<configured database URL>
SUPABASE_DB_CA_CERT=<configured CA certificate when required>
```

Secret values are configured in the deployment environment, never committed to this repository.

## Manual execution

Build and run once against an approved configured database:

```bash
npm run process:outbox
```

The command prints the number of rows processed and exits non-zero when application startup or relay persistence fails. Do not run a second copy concurrently as an operational workaround; inspect the scheduler, lease state, database connectivity, and quarantine state first.

## Investigation checklist

1. Check the Render cron execution log for startup, explicit hierarchy-mode, timeout, or database errors.
2. Inspect pending, leased, retrying, and quarantined rows in `platform.outbox_events` using an approved read-only database session.
3. For a leased row, compare `lease_expires_at` with the current time. Do not manually clear an active lease while its worker may still be running.
4. Confirm the topic is in `src/kernel/events/outbox-topics.ts` and has exactly one dispatcher handler.
5. Confirm downstream side effects are idempotent before replaying a quarantined row.
6. Record the row IDs, topic, lease state, error, action, and verification result.

## Rollback and recovery

- The reliability rollback fails closed when any retry or quarantine diagnostic exists. Export and resolve those rows with an approved replay or recovery procedure before retrying; do not clear `last_error` or `quarantined_at` merely to force the downgrade.
- Run the quarantine rollback to requeue only the exact legacy topics changed by that migration.
- If a topic is pending but not registered, do not acknowledge it. Identify its historical producer, add an explicit owner or quarantine migration, and record the decision before changing its status.

Use the [event map](/architecture/events-map.generated.md) and [outbox decision](/architecture/decisions/adr-0005-postgresql-outbox-delivery.md) as the contract.
