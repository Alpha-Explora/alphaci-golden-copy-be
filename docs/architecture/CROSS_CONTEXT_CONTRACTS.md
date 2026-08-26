# Cross-context contract register

This register is the implementation map for the six-context target. The
the repository now has six physical context directories; these contracts are
published from the nested module indexes so the consolidation does not change
the consumer vocabulary.

## Contract rules

- Contract files contain serializable types only.
- Provider and database details remain private to `deployments`/`runtime`.
- A port is added only for an actual inversion, an optional context, or the
  first extraction candidate. Ordinary reads continue through an owning
  context index until a transport boundary is needed.
- Composition-only bridges are wired at the application root rather than by
  making the two contexts import one another's Nest modules.

## Edge register

| Future edge | Contract surface | Port status |
|---|---|---|
| `identity-access -> projects` | `kernel/ports/project-lookup.port.ts` | `ProjectLookupPort` — cycle-breaking write |
| `identity-access -> pipelines` | `github/index.ts`, `github-installation.contract.ts` | context index; role sync is inverted through `PlatformAdminPort` |
| `identity-access -> billing` | `subscription/index.ts` | context index |
| `identity-access -> platform-ops` | `kernel/events/platform-event.registry.ts` | `AuditEventPublisher` |
| `projects -> pipelines` | `github/index.ts`, `ci/index.ts` | context index |
| `projects -> runtime` | `deployments/index.ts`, `deployment-provisioning.contract.ts` | existing provisioning facade/token |
| `projects -> billing` | `usage/index.ts`, `subscription/index.ts` | context index; optional-edition quota port deferred |
| `projects -> platform-ops` | `kernel/events/platform-event.registry.ts` | audit/notification publishers |
| `projects -> identity-access` | `workspaces/index.ts`, `hierarchy/index.ts` | context indexes |
| `runtime -> identity-access` | `workspaces/index.ts` | context index |
| `runtime -> pipelines` | `github/index.ts` | context index |
| `runtime -> billing` | `usage/index.ts` | context index |
| `runtime -> platform-ops` | `kernel/events/platform-event.registry.ts` | audit/notification publishers |
| `pipelines -> identity-access` | `kernel/ports/platform-admin.port.ts` | `PlatformAdminPort` — cycle-breaking role policy |
| `pipelines -> platform-ops` | `kernel/events/platform-event.registry.ts` | `AuditEventPublisher` |

The deployment provider metadata, usage facts, and workflow fragments are
runtime-owned contracts. They are deliberately separate from the future
service transport contracts: adding a provider must not add a context edge.

Async sink conversion is implemented with an in-process relay. The compiled
`scripts/process-outbox.cjs` runner invokes `OutboxRelayService`, while
`OutboxRepository.processPending()` uses a PostgreSQL advisory lock so only
one process owns the table at a time. Delivery is at-least-once: handlers must
be idempotent across a crash between dispatch and the published update. The
critical `recordAlwaysOn` audit path remains synchronous, as does the audit
read used by the project API.
