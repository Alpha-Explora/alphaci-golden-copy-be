---
type: "Executable Contract"
title: "AlphaCI backend constitution"
description: "Current executable invariants for context ownership, composition, events, schemas, and documentation."
tags: [architecture, constitution, contracts]
status: stable
sources:
  - id: app-composition
    resource: "src/app.module.ts"
    title: "Nest application composition root"
  - id: boundary-gates
    resource: "scripts/check-application-boundaries.cjs"
    title: "Application boundary gate"
  - id: schema-gate
    resource: "scripts/check-schema-ownership.cjs"
    title: "Schema ownership gate"
---
# AlphaCI backend constitution

This document is the current contract for the backend. A code, schema, deployment, or documentation change that violates an invariant must update the relevant source and its verification evidence in the same change.

## Context ownership

The application has six bounded contexts: `identity-access`, `projects`, `pipelines`, `runtime`, `billing`, and `platform-ops`. The [bounded context map](/architecture/context-map.generated.md) is generated from the source tree.

- The technical kernel is shared infrastructure only and never imports a business context.
- A provider, deployment mode, capability, or pack is not an additional bounded context.
- Each context owns its application policy, persistence boundary, public index, and composition root.
- Cross-context production code uses a public index, serialisable contract, or focused injected port. Composition-only Nest module imports are allowed at context roots.

## Product axes

Edition, tenancy, deployment target, deployment mode (`ALPHACI_DEPLOYMENT_MODE`: managed `saas` or `selfhosted`), and feature flag are independent values. Editions compose from capability declarations; they do not create copied domain implementations. A lower configuration layer cannot enable a capability that the build or selected edition does not provide.

The narrowing order is:

```text
build -> edition manifest -> deployment configuration -> tenant override
```

The [capability contract](/capabilities/capability-contract.md) and [pack contract](/packs/pack-contract.md) define the documentation-level representation of these values. Runtime capability behavior remains in the existing application implementation.

## Runtime providers

Provider implementations belong to Runtime under `src/modules/runtime/infrastructure/providers/`. Each provider is composed as one validated `RuntimeProviderPack`; a provider that advertises environment provisioning must contribute a matching runtime client. Other contexts consume provider-neutral contracts and catalog data. Provider-specific credentials, policies, workflow fragments, and adapters do not become shared business logic. The [provider map](/architecture/provider-map.generated.md) records the current registered providers.

## Events and outbox

The active event mechanism is the PostgreSQL table `platform.outbox_events`, processed by the platform-ops `OutboxRelayService`. The API runs it on in-process timers, and `scripts/process-outbox.cjs` runs it as a one-shot job that `render.yaml` schedules for the managed deployment.

- The kernel topic registry is the allow-list and every registered topic has one handler.
- Every consumer claims rows through the same leased `FOR UPDATE SKIP LOCKED` path, so concurrent consumers never deliver one row at the same time.
- Critical hierarchy assignment transitions insert the state change and outbox row in one transaction.
- Audit and notification writes are explicit best-effort post-commit observability writes.
- Delivery is at-least-once. The relay uses short row leases, retry scheduling, and quarantine; handlers must be idempotent.

See the [event map](/architecture/events-map.generated.md) and [outbox relay runbook](/runbooks/runbook-outbox-relay.md).

## Schema ownership

Migration directories and inline SQL are checked against the six context owners. Existing cross-schema references are exact transition allowances in the source gate; new references require an explicit ownership decision. The [schema map](/architecture/schema-ownership.generated.md) is generated from that gate.

## Documentation contract

Canonical documentation is repository-portable and current-state only. It must not depend on external session context, a branch, a checkout path, or a dated execution plan. New documents use lower-kebab-case names unless a conventional entrypoint requires otherwise. Every change that alters a documented contract updates the affected concept, generated map, `docs/log.md`, and root `CHANGELOG.md`.

The [architecture checks](/architecture/architecture-checks.generated.md) and [local verification runbook](/runbooks/runbook-local-verification.md) are the executable navigation points for this rule.
