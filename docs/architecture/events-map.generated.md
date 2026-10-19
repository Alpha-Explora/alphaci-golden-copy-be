---
type: "Event Map"
title: "Current event and outbox map"
description: "Generated map of the PostgreSQL outbox topics, owners, and active in-process relay."
tags: [architecture, events, map, operations]
status: stable
sources:
  - id: "topic-source"
    resource: "src/kernel/events/outbox-topics.ts"
    title: "Outbox topic registry"
  - id: "relay-source"
    resource: "src/modules/platform-ops/application/outbox-relay.service.ts"
    title: "Active outbox relay"
  - id: "relay-worker"
    resource: "src/modules/platform-ops/application/outbox-relay.worker.ts"
    title: "In-process relay worker"
  - id: "schema-source"
    resource: "supabase/migrations/identity-access/20260606_domain_schema_bootstrap.sql"
    title: "Outbox table migration"
---

# Current event and outbox map

The active event mechanism is a PostgreSQL-backed outbox inside the one NestJS deployable. It is an asynchronous in-process work queue. It is not a broker, and it does not create a network hop.

## Registered topics

| Topic | Owner | Producer | Handler | Write semantics |
|---|---|---|---|---|
| `hierarchy.repository_assignment.grant` | `identity-access` | identity-access hierarchy assignment transaction | identity-access / GithubSyncOutboxHandler | transactionally coupled to the critical hierarchy mutation |
| `hierarchy.repository_assignment.revoke` | `identity-access` | identity-access hierarchy assignment transaction | identity-access / GithubSyncOutboxHandler | transactionally coupled to the critical hierarchy mutation |
| `platform.audit.recorded` | `platform-ops` | contexts using AuditEventPublisher | platform-ops / OutboxRelayService / AuditEventsService | best-effort post-commit observability write |
| `platform.notification.requested` | `platform-ops` | contexts using NotificationEventPublisher | platform-ops / OutboxRelayService / NotificationEventsService | best-effort post-commit notification request |

## Delivery path

1. A producer calls the kernel event publisher or the owning hierarchy repository.
2. `OutboxRepository` inserts into `platform.outbox_events`. Critical hierarchy transitions call `publishInTransaction` on the same PostgreSQL client as the state mutation. Audit and notification publishers use explicit best-effort post-commit writes.
3. `OutboxDispatcher` registers one handler for each active topic.
4. `OutboxRelayService` claims rows for three consumers. `OutboxRelayWorker` runs inside the API every `OUTBOX_RELAY_INTERVAL_MS` (default 15 seconds, `0` turns it off) and delivers audit and notification topics, plus hierarchy topics when `HIERARCHY_GITHUB_SYNC_MODE=live`. `NotificationRelayWorker` runs inside the API every `NOTIFICATION_RELAY_INTERVAL_MS` (default 1 second) and delivers notification topics only. `scripts/process-outbox.cjs` starts the compiled Nest application context and drains every registered topic; the managed deployment schedules it as a Render cron in `render.yaml`.
5. A short `FOR UPDATE SKIP LOCKED` transaction assigns an expiring lease before a handler runs, so consumers never deliver one row at the same time and external I/O does not hold a database connection or process-wide lock.
6. Successful rows become `status = 'published'` with `published_at`. Failed rows are retried with `available_at`, then quarantined after the configured attempt limit. Acknowledgement and failure updates require the lease token.

Delivery is at-least-once. A handler can run again if the process stops after the side effect and before the acknowledgement update, so handlers must remain idempotent. The topic allow-list prevents an unowned row from being acknowledged by the wrong handler.

## Operator references

See the [outbox relay runbook](/runbooks/runbook-outbox-relay.md), the [PostgreSQL outbox decision](/architecture/decisions/adr-0005-postgresql-outbox-delivery.md), and the [current architecture](/architecture/current-architecture.md).
