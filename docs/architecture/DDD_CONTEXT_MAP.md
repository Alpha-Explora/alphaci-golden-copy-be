# AlphaCI Backend bounded-context map

This map describes ownership in the six-context modular monolith. It is a
code-ownership and contract document; it does not by itself change HTTP
behavior, database schemas, or provider behavior.

## Contexts

| Context | Owns | Public boundary | Does not own |
|---|---|---|---|
| `identity-access` | auth, admin, capabilities, workspaces, hierarchy, repository access state | `src/modules/identity-access/index.ts`, focused contracts/ports, hierarchy event topics | project entities, provider clients, billing policy |
| `projects` | project lifecycle, catalog, workflows, existing repos, project read models | `src/modules/projects/index.ts`, `contracts/` | provider credentials, provider clients, deployment persistence |
| `pipelines` | GitHub integration, CI token lifecycle, CI report ingestion | `src/modules/pipelines/index.ts`, CI/GitHub contracts | project authorization, provider APIs |
| `runtime` | deployment targets, env metadata, domains, provider connections, provider adapters/history | `src/modules/runtime/index.ts`, runtime contracts/ports | project authorization and project persistence |
| `billing` | subscriptions, usage, quotas | `src/modules/billing/index.ts` | provider registries, provider SQL |
| `platform-ops` | audit, notifications, feedback, outbox consumers | `src/modules/platform-ops/index.ts`, serialisable event topics | business aggregates and provider policy |

`kernel/` is technical infrastructure only: database access, configuration,
HTTP cross-cutting concerns, session contracts, and outbox plumbing. It may not
import a bounded context or define a business entity.

## Ubiquitous language

- A **Project** is the Projects-owned user product setup and lifecycle record.
- A **ProjectReference** is a serialisable, viewer-authorized reference passed
  to runtime; it is not a Projects repository row.
- A **DeploymentTarget** is a Runtime-owned provider-backed target for one
  project slot.
- A **ProviderConnection** is Runtime-owned credential custody and connection
  metadata. Encryption and transport remain infrastructure concerns.
- An **EnvironmentScope** is a lane plus branch value: production has no branch;
  preview requires one.
- A **DeploymentProvider** is a plugin inside Runtime. Render, Vercel, and GCP
  are adapters, not contexts.
- An **outbox event** is a serialisable integration record in
  `platform.outbox_events`. The topic registry names its owner and the relay
  dispatches only registered topics.

## Context interaction rules

1. Production cross-context callers use the owning `index.ts`, a serialisable
   `contracts/` type, or a focused injected port. They do not import another
   context's concrete service, repository, DTO, or provider adapter.
2. Composition roots may import Nest feature modules to build the in-process
   graph. This is wiring, not an application-level dependency.
3. Stale-tolerant audit and notification writes use kernel event publishers and
   are consumed by `platform-ops`; they are intentionally best-effort
   post-commit writes. They must not be described as transactionally coupled.
4. Hierarchy grant/revoke events are critical integration work. The state
   mutation and outbox insert use one PostgreSQL transaction; the GitHub
   handler is idempotent/at-least-once aware.
5. Provider-specific rules remain within Runtime. Other contexts receive
   provider-neutral contracts and may store/return the existing provider id as
   part of their public API where compatibility requires it.
6. SQL ownership is governed by
   `docs/architecture/SCHEMA_OWNERSHIP.md`; existing cross-schema references
   are explicit transition debt, not a new dependency pattern.

## Domain invariants

Runtime currently keeps the following rules in framework-free policy functions:

1. provider/slot combinations must be supported;
2. target lifecycle transitions must be valid;
3. BYO targets must reference a compatible active ProviderConnection;
4. production environment values have no branch and preview values require a
   non-empty valid branch;
5. provider configuration is validated by the owning provider adapter.

Projects keeps lifecycle rules in its application services until a second
consumer justifies a separate domain object. This is deliberate progressive
depth, not an omitted boundary.

## Future-only extraction posture

The ports and contracts are local in-process seams today. If independent
scaling, deployment cadence, or regulatory isolation is later demonstrated,
bind the same ports to an HTTP/gRPC adapter and publish the serialisable
contracts. Microservice extraction is outside the current consolidation plan
and is not scheduled from this document alone.
