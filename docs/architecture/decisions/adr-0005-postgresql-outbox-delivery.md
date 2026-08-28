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

The relay uses an advisory lock, selects only topics owned by registered handlers, orders pending rows by creation time and ID, acknowledges successful rows with `published_at`, retries failures with backoff, and quarantines terminal failures. Delivery is at-least-once and downstream handlers must be idempotent.

## Rejected alternatives

- A second runner for the same table was rejected.
- An unfiltered relay that acknowledges topics without a registered owner was rejected.
- Describing best-effort audit/notification writes as transactionally coupled was rejected.
- Introducing a broker is not part of the current delivery mechanism.

## Consequences

- Business state and critical hierarchy events commit together.
- Non-critical event loss remains visible as a warning rather than changing the business mutation result.
- A process crash can cause a handler to run again; handler idempotency is required.
- Operators have one scheduler, one command, one table, and one runbook to inspect.

## Verification

Run `npm run process:outbox` only against an approved configured database, run the outbox scheduler and repository tests, and use the [outbox relay runbook](/runbooks/runbook-outbox-relay.md). The [event map](/architecture/events-map.generated.md) is generated from the topic registry and relay sources.
