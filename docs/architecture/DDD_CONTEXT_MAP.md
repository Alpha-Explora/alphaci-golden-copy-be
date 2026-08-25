# AlphaCI Backend DDD Context Map

This map defines ownership for the modular-monolith refactor. It changes no
runtime behavior, HTTP contract, database schema, or provider behavior.

## Bounded contexts

| Context | Owns | Does not own |
| --- | --- | --- |
| Projects | Project lifecycle, project ownership, setup authorization, project workflow configuration, project-owned persistence | Provider credentials, provider clients, deployment-target persistence |
| Deployments | DeploymentTarget lifecycle, ProviderConnection custody, environment synchronization, provider status/history, provider adapters | Project authorization and Project persistence |
| CI | Project CI-token lifecycle and authenticated CI report ingestion | Provider API calls and deployment-target rules |
| Workflows | Workflow document composition and workflow history | Provider-specific branching and provider credentials |
| Usage | Quota and usage policy | Provider registries and provider-specific SQL |
| Auth | Users, OAuth state, session-user lookup | Subscription and platform-admin policy |
| Kernel | Database client, configuration, HTTP cross-cutting concerns, technical auth contracts, outbox plumbing | Business entities, business repositories, provider rules |

## Ubiquitous language

- A **Project** is the Projects aggregate representing a user-owned product
  setup and its lifecycle.
- A **ProjectReference** is an immutable cross-context reference containing only
  the project identity and data required by a deployment use case. It is not a
  Project entity or persistence record.
- A **DeploymentTarget** is the Deployments aggregate representing one
  provider-backed target for a project slot.
- A **ProviderConnection** is a Deployments entity representing provider
  credential custody and connection status. Credential encryption and transport
  are infrastructure concerns.
- An **EnvironmentScope** is a value object containing a lane and, for preview
  scopes, a branch. Invalid lane/branch combinations are rejected together.
- A **DeploymentProvider** is an infrastructure adapter implementing the
  provider-neutral deployment contract. Render and Vercel are adapters, not
  separate business contexts.

## Deployment invariants

These are the only rules that justify the initial Deployments domain layer:

1. A target's provider and slot combination must be supported.
2. A target lifecycle transition must be valid for its current state.
3. A target using customer-owned credentials must reference an active compatible
   ProviderConnection.
4. A preview EnvironmentScope must include a non-empty branch; production has
   no branch.
5. Provider-specific configuration is validated by the owning provider adapter
   and does not leak into the shared domain vocabulary.

## Anti-corruption boundaries

Projects calls Deployments through DeploymentProvisioningFacade,
DeploymentHistoryQuery, and DeploymentDriftQuery. It passes ProjectReference
and user/authorization context and receives deployment-owned result contracts.

Deployments must not import ProjectsService, ProjectsRepository, project DTOs,
or project database rows. Projects remains responsible for authorizing access
before invoking a deployment query or command.

Provider adapters translate provider terminology and errors into deployment
contracts. Workflows and Usage consume provider-neutral contracts and never
branch on Render, Vercel, or GCP implementation details.

The kernel is technical infrastructure, not a business shared kernel. It may
define injection tokens and technical types, but it must not define Project,
DeploymentTarget, ProviderConnection, or provider policies.
