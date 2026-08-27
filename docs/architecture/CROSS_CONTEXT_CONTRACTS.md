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

## Current event and outbox model

The active event mechanism is a durable PostgreSQL outbox inside the one NestJS
deployable. It is an asynchronous in-process work queue, not Kafka, Pub/Sub, a
broker, or a microservice transport. Writing an outbox row does not create a
network hop or an independently deployed service.

### Topics and ownership

The active table is `platform.outbox_events`, defined in the existing domain
bootstrap migration. `OUTBOX_TOPICS` and `OUTBOX_TOPIC_OWNERS` are the kernel
allow-list. The only active topics are:

- `platform.audit.recorded` → `platform-ops`;
- `platform.notification.requested` → `platform-ops`;
- hierarchy assignment grant/revoke → `identity-access`.

Producers cannot insert an unregistered topic. The shared
`OutboxDispatcher` has one handler per registered topic: `platform-ops`
handles audit/notification, while `identity-access` handles hierarchy grant
and revoke GitHub-sync work.

### Runtime flow

1. A use case creates a serialisable event with a topic, aggregate identity,
   and JSON payload.
2. A critical hierarchy transition calls
   `OutboxRepository.publishInTransaction(client, event)` using the same
   PostgreSQL transaction as the assignment and sync-row mutation. The state
   change and pending event therefore commit or roll back together.
3. Audit and notification publishers use the explicit
   `publishBestEffort(event)` post-commit seam because those sinks are
   historically non-critical. `publishDurably(event)` remains available for
   strict non-transactional/manual or retry work.
4. The single Render cron owner, `alphaci-outbox-relay`, runs
   `scripts/process-outbox.cjs` once per minute. That runner boots the normal
   `AppModule` and invokes the in-process relay; there is no second Kafka-era
   runner.
5. The relay takes the PostgreSQL advisory lock, selects only pending,
   available rows whose topics are registered with the dispatcher, and invokes
   the owning handler.
6. A successful handler marks the row `status='published'` with
   `published_at`. A failed handler leaves it pending, increments `attempts`,
   and schedules the next attempt with backoff.

### Guarantees and limits

- Critical transaction-coupled events survive a crash before dispatch because
  the pending row remains in PostgreSQL.
- Delivery is **at least once**. A crash after a handler performs its side
  effect but before the published update can repeat that side effect, so
  handlers must be idempotent.
- Best-effort audit/notification events can be dropped if their separate
  outbox write fails; they are not transactionally coupled business events.
- The current design intentionally has no broker, inbox, dead-letter queue, or
  independent event service. Legacy unowned rows are quarantined rather than
  consumed by an arbitrary handler.

## Future-only transport reference

If an operational trigger later justifies extraction, a context port can be
rebound to an HTTP/gRPC adapter and the serialisable contract can become a
versioned package. Callers and domain logic should remain unchanged. No broker,
gateway, schema split, or service extraction is scheduled by this register.
