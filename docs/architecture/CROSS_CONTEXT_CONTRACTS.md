# Cross-context contract register

This register describes the six physical context boundaries and the seams that
can later be bound to an out-of-process adapter. The current application is
still a modular monolith; a context index or port is an in-process dependency,
not evidence that a network service already exists.

## Contract rules

- `contracts/` and port files contain serialisable types and no Nest, database,
  or vendor SDK imports.
- Cross-context production code does not import another context's concrete
  service, repository, DTO, or provider implementation.
- A port exists only for a real inversion, an optional context, or a likely
  transport swap. Same-process/same-schema reads may use the owning context's
  public index.
- Nest module imports are composition wiring and are kept in context roots;
  they are not application-level contracts.
- Provider contracts and registries belong to `runtime`; a provider is not a
  new context edge.

## Edge register

| Context edge | Current contract surface | Seam |
|---|---|---|
| `identity-access -> projects` | `kernel/ports/project-lookup.port.ts` | `ProjectLookupPort` breaks the cycle for hierarchy-managed projects |
| `identity-access -> pipelines` | `#modules/pipelines/index` and GitHub contracts | context index; role policy uses `PlatformAdminPort` where inversion is needed |
| `identity-access -> billing` | `#modules/billing/index` | in-process subscription/usage contract |
| `identity-access -> platform-ops` | `#kernel/events/platform-event.registry` | best-effort audit/notification publishers |
| `projects -> pipelines` | `#modules/pipelines/index` and CI contracts | in-process GitHub/CI contract |
| `projects -> runtime` | `#modules/runtime/index` and runtime contracts | provisioning/history/drift tokens; first extraction candidate |
| `projects -> billing` | `#modules/billing/index` | in-process quota contract; edition-optional port remains a future slice |
| `billing -> runtime` | `#modules/runtime/index` | Runtime-owned deployment usage facts consumed as data by quota policy |
| `projects -> platform-ops` | `#kernel/events/platform-event.registry` | best-effort audit/notification publishers |
| `projects -> identity-access` | identity-access indexes and project-link contract | in-process authorization/reference contract |
| `runtime -> identity-access` | identity-access workspace contract | in-process workspace access contract |
| `runtime -> pipelines` | `#modules/pipelines/index` | in-process GitHub/CI contract |
| `runtime -> billing` | `#modules/billing/index` | in-process usage/quota contract |
| `runtime -> platform-ops` | `#kernel/events/platform-event.registry` | best-effort audit/notification publishers |
| `pipelines -> identity-access` | `kernel/ports/platform-admin.port.ts` | `PlatformAdminPort` breaks the role-policy cycle |
| `pipelines -> platform-ops` | `#kernel/events/platform-event.registry` | best-effort audit publisher |

The conceptual register contains 16 current directional context pairs. The
metric report counts more file-level imports than this register because one
context edge can have several callers and because Nest composition imports are
visible in the physical graph. The metric is therefore a trend indicator, not
a claim that there are only 16 import statements.

## Outbox contract and guarantees

The active table is `platform.outbox_events`, defined in the existing domain
bootstrap migration. `OUTBOX_TOPICS` and `OUTBOX_TOPIC_OWNERS` are the kernel
allow-list. The only active topics are:

- `platform.audit.recorded` → `platform-ops`;
- `platform.notification.requested` → `platform-ops`;
- hierarchy assignment grant/revoke → `identity-access`.

`OutboxRepository.publishInTransaction(client, event)` is the transactional
primitive. Hierarchy assignment state transitions that enqueue grant/revoke
work use it on the same PostgreSQL transaction as the state mutation.
`publishDurably(event)` is strict for manual/retry work. Audit and notification
publishers intentionally use `publishBestEffort(event)` after a business
mutation has committed because those sinks were historically non-critical;
their writes may be dropped if the database is unavailable. They are not
transactionally coupled and this document does not promise that they are.

`OutboxRelayService` is the only application consumer. The compiled
`scripts/process-outbox.cjs` is the only scheduled runner, and
`render.yaml` declares one cron owner. The relay selects only topics registered
by its dispatcher, holds a PostgreSQL advisory lock, acknowledges with
`published_at`, and leaves failed rows pending with backoff. Delivery is
at-least-once, so handlers must be safe to repeat.

## Future transport swap

When an operational trigger exists, a context port can be rebound to an
HTTP/gRPC adapter and the serialisable contract can become a versioned package.
Callers and domain logic should remain unchanged. No broker, gateway, schema
split, or extraction is scheduled by this register.
