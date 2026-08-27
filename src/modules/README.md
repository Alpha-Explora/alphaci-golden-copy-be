# Bounded-context modules

`src/modules/` contains six bounded-context composition roots. A context is a
business ownership boundary; a provider, repository, or deployment mode is not
an additional top-level module.

```text
modules/
├── identity-access/   auth, admin, capabilities, workspaces, hierarchy
├── projects/          projects, catalog, workflows, existing repositories
├── pipelines/         GitHub integration and CI reporting
├── runtime/           deployment targets, environment variables, providers
├── billing/           subscriptions and usage/quota policy
└── platform-ops/      audit, notifications, feedback, outbox consumers
```

Each context has a `<context>.module.ts` composition root and an `index.ts`
public API. Complex features may use the following layers; simple features stay
flat rather than creating empty folders:

```text
api/             controllers and request/response DTOs
application/     use cases and orchestration
domain/          framework-free business rules
infrastructure/  repositories and provider adapters
contracts/       serialisable cross-context types and focused ports
```

## Boundary rules

1. Cross-context production code imports only the owning context's `index.ts`,
   `contracts/`, or an injected port token. A feature's concrete service,
   repository, DTO, or provider adapter is private.
2. Context composition roots may import another context's Nest module when the
   Nest graph needs to be assembled. This is composition wiring, not a public
   business dependency.
3. `kernel/` may be used by contexts, but `kernel/` may never import a context.
4. Provider implementations live under `runtime/infrastructure/providers/<id>`.
   Adding a provider uses the generic registries and one composition binding;
   it must not create a seventh context or add vendor literals to another
   context.
5. No circular dependencies exist between contexts or within their module
   graphs.

The rules are checked by `.dependency-cruiser.cjs`,
`check:application-boundaries`, `check:provider-encapsulation`, and the schema
ownership gate. The architecture metrics report is descriptive; dependency-
cruiser is the authoritative import graph.
