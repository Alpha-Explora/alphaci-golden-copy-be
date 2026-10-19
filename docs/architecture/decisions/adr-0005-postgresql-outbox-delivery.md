---
type: "Decision"
title: "PostgreSQL outbox delivery"
description: "Use one PostgreSQL outbox table and one scheduled in-process relay with explicit topic ownership."
tags: [architecture, decision, events, postgresql]
status: stable
timestamp: "2026-08-28T00:00:00Z"
sources:
  - id: outbox-repository
    resource: "src/kernel/events/outbox.repository.ts"
    title: "Outbox persistence and relay query"
  - id: outbox-topics
    resource: "src/kernel/events/outbox-topics.ts"
    title: "Registered outbox topics"
  - id: relay
    resource: "src/modules/platform-ops/application/outbox-relay.service.ts"
    title: "Application relay"
  - id: scheduler
    resource: "render.yaml"
    title: "Scheduled relay deployment"
---
# ADR-0005: PostgreSQL outbox delivery

**Decision date:** 2026-08-28
**Decision status:** Accepted
**Scope:** Integration events emitted and consumed by the backend

## Decision

The backend uses `platform.outbox_events` as its durable integration-event table. The kernel owns the topic allow-list, persistence repository, and dispatcher. The compiled `scripts/process-outbox.cjs` entrypoint invokes `platform-ops` `OutboxRelayService`, and the Render cron in `render.yaml` is the single deployment-level scheduler for this table.

The registered topics are:

- `platform.audit.recorded` handled by `platform-ops`;
- `platform.notification.requested` handled by `platform-ops`;
- `hierarchy.repository_assignment.grant` handled by `identity-access`;
- `hierarchy.repository_assignment.revoke` handled by `identity-access`.

Critical hierarchy state changes and their outbox inserts use the same PostgreSQL transaction. Audit and notification writes use explicit best-effort post-commit methods because they are non-critical observability effects.

The relay claims only topics owned by registered handlers, orders pending rows by creation time and ID, and uses a short `FOR UPDATE SKIP LOCKED` transaction to assign an expiring lease. External handlers run after the claim transaction commits. Acknowledgements, retries, and quarantine updates require the claim token, so a late worker cannot overwrite a newer claim. Successful rows are acknowledged with `published_at`; failures retry with backoff and then become quarantined. Delivery is at-least-once and downstream handlers must be idempotent.

The configured lease must be longer than the handler timeout after bounds are applied. The relay rejects an unsafe timing configuration rather than allowing a handler to outlive its claim and run concurrently with a reclaiming worker.

## Rejected alternatives

- A second scheduler for the same table was rejected.
- An unfiltered relay that acknowledges topics without a registered owner was rejected.
- Describing best-effort audit/notification writes as transactionally coupled was rejected.
- Introducing a broker is not part of the current delivery mechanism.

## Consequences

- Business state and critical hierarchy events commit together.
- Non-critical event loss remains visible as a warning rather than changing the business mutation result.
- A process crash can cause a handler to run again; handler idempotency is required.
- A handler timeout or expired lease can cause a handler to run again; provider calls must have bounded timeouts and safe replay behavior.
- The lease/timeout invariant is enforced at relay configuration time; an invalid configuration fails closed before a row is claimed.
- Operators have one scheduler, one command, one table, and one runbook to inspect.

## Amendment: in-process relay workers (2026-10-20)

The Render cron is no longer the only scheduler. The API process also drains the table:

- `OutboxRelayWorker` runs every 15 seconds (`OUTBOX_RELAY_INTERVAL_MS`; `0` turns it off). It always delivers the platform topics. It delivers the hierarchy grant/revoke topics only when `HIERARCHY_GITHUB_SYNC_MODE=live`, because their handlers change GitHub team membership.
- `NotificationRelayWorker` delivers notification rows every second (`NOTIFICATION_RELAY_INTERVAL_MS`, 250 ms to 60 s; off when either interval is `0`).

A self-hosted install has no cron; these workers are its relay. Running them beside the cron, or on several API replicas, delivers nothing twice: every claim is leased and taken with `SKIP LOCKED`. The rejected "second scheduler" alternative is superseded by this lease guarantee. The claim, lease, retry and quarantine rules above are unchanged.

## Verification

Run `npm run process:outbox` only against an approved configured database, run the outbox scheduler and repository tests, and use the [outbox relay runbook](/runbooks/runbook-outbox-relay.md). The [event map](/architecture/events-map.generated.md) is generated from the topic registry and relay sources.
