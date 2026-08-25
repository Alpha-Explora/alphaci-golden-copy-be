# Modular Monolith Boundary Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Restore enforceable modular-monolith boundaries, including a modular deployment-provider feature, without changing observable business behavior.

**Architecture:** Keep one NestJS application and convert internal feature dependencies into deliberate public contracts. Move shared technical concerns into the kernel, keep business repositories with their owning modules, and establish deployments as the owner of deployment targets, provider credentials, environment synchronization, and provider integrations. Every migration is a behavior-preserving move or adapter introduction; it must retain existing routes, response shapes, authorization, database semantics, provider behavior, and error contracts.

**Tech Stack:** NestJS 11, TypeScript 5, PostgreSQL via pg/Supabase, Jest, dependency-cruiser.

## Global Constraints

- No endpoint, request DTO, response DTO, status code, authorization rule, provider behavior, database value, or existing event payload may change in this plan.
- Do not add GCP support, provider capabilities, new HTTP routes, schema redesigns, or deployment behavior. The existing GCP/provider feature plan is a later feature delivery; this plan only creates safe architectural seams for it.
- Preserve the current env-provisioning HTTP paths until a separately approved API-versioning change.
- Each change must reduce the known dependency-cruiser baseline or leave it unchanged; it must never add an entry.
- Kernel code may not import from src/modules.
- Cross-module callers import only a module index.ts public API. Repositories, controllers, vendor clients, and internal DTOs are private.
- Use the existing project test style and preserve current test coverage before moving a behavior.
- A domain directory contains only framework- and vendor-independent rules. An
  application service coordinates use cases; an infrastructure adapter owns SQL,
  HTTP clients, encryption, and provider SDK details.
- Do not create an aggregate, repository port, domain event, or domain service
  without a named invariant, replacement seam, or independently consumed fact.
- GitHub Actions minutes are unavailable. Do not add, modify, or rely on a
  GitHub Actions workflow for this migration; run every listed validation command
  locally before each commit and before merge.

---

## Planned ownership after the migration

| Owner | Responsibility | Explicit non-owner responsibilities |
| --- | --- | --- |
| kernel/db | Database client, SSL, transaction utility | Feature repositories and queries |
| kernel/auth | Generic guards and auth contracts | Users repository implementation |
| auth | Users, OAuth state, SessionUserLookup adapter | Subscription and platform-admin policy |
| deployments | Deployment targets, provider connections, encrypted credentials, env variables, provider status/history, provider adapters | Project creation and project authorization |
| projects | Project lifecycle, dashboard, previews, project workflow changes, project-owned persistence | Provider credentials, provider clients, target persistence |
| ci | CI tokens and report ingestion | Provider-specific deployment API behavior |
| workflows | Generic workflow document composition | Render/Vercel/GCP branching |
| usage | Quota policy | Provider registry and provider-specific storage |

## DDD context map and ubiquitous language

The terms below are the required vocabulary in code, tests, and public module
contracts. They prevent a folder reorganization from becoming architecture in
name only.

| Bounded context | Domain concepts and invariants | Public boundary |
| --- | --- | --- |
| Projects | Project lifecycle, project ownership, project setup authorization, project workflow configuration | ProjectReference and project application facades; never a ProjectsRepository |
| Deployments | DeploymentTarget lifecycle, ProviderConnection custody, EnvironmentScope, provider/slot compatibility, deployment status | DeploymentProvisioningFacade, deployment query facades, provider-neutral contract types |
| CI | Project CI token lifecycle and authenticated report ingestion | CI token status/query contract only when another context needs it |
| Workflows | Workflow document composition and durable workflow history | Workflow contribution contract; no provider switch statements |
| Usage | Usage and quota policy | Provider-neutral deployment usage fact or query contract |
| Auth | User identity, OAuth state, session-user lookup | SessionUserLookup contract |

**Aggregates and value objects**

- Project remains the aggregate in Projects. Deployments may hold its immutable
  ProjectReference but never the Project entity or repository.
- DeploymentTarget is the aggregate in Deployments. Its invariants are the
  permitted provider/slot pairing, target lifecycle transition, and valid link
  to an active ProviderConnection where the ownership mode requires one.
- ProviderConnection is an entity owned by Deployments; encrypted credential
  storage and credential validity remain infrastructure concerns.
- EnvironmentScope is a value object: lane and branch are validated together so
  a preview scope cannot exist without its branch.

**Anti-corruption boundaries**

- Projects asks Deployments to provision or query targets through
  DeploymentProvisioningFacade and deployment query facades. It passes
  ProjectReference data and receives deployment-owned result contracts.
- Deployments must not import ProjectsService, project DTOs, project database
  rows, or ProjectsRepository.
- Provider adapters translate Render and Vercel terms into deployment-owned
  contracts. Provider-specific fields never escape an adapter as public domain
  vocabulary.
- Kernel is technical shared infrastructure, not a DDD shared kernel. It may
  define technical tokens and types, but no Project, DeploymentTarget, or
  provider business rule.

## Future-state tree

This is the intended end state after Task 11. It is a single NestJS modular
monolith, not a microservice layout. A domain directory exists only where the
module has a framework-independent invariant; it is not mandatory scaffolding.

    src/
    ├── main.ts
    ├── app.module.ts                              # root composition only
    ├── health/
    ├── kernel/
    │   ├── auth/
    │   │   ├── session-auth.guard.ts
    │   │   ├── subscription.guard.ts
    │   │   └── session-user-lookup.contract.ts
    │   ├── config/
    │   │   ├── app.config.ts
    │   │   ├── env.validation.ts
    │   │   └── security.config.ts
    │   ├── db/
    │   │   ├── database.module.ts
    │   │   ├── database.service.ts
    │   │   ├── postgres-ssl.config.ts
    │   │   └── transaction.port.ts                # only if an abstraction is justified
    │   ├── events/
    │   │   ├── outbox.repository.ts
    │   │   └── outbox-worker.ts
    │   ├── http/
    │   │   ├── all-exceptions.filter.ts
    │   │   └── correlation-id.middleware.ts
    │   └── types/
    ├── modules/
    │   ├── admin/{api,application,infra,admin.module.ts,index.ts}
    │   ├── audit/{application,infra,audit.module.ts,index.ts}
    │   ├── auth/
    │   │   ├── api/
    │   │   ├── application/{auth.service.ts,session-user-lookup.adapter.ts,ports}
    │   │   ├── infra/{users.repository.ts,oauth-state.repository.ts}
    │   │   ├── auth.module.ts
    │   │   └── index.ts
    │   ├── capabilities/{api,application,capabilities.module.ts,index.ts}
    │   ├── catalog/{api,application,infra,catalog.module.ts,index.ts}
    │   ├── ci/{api,application,infra,ci.module.ts,index.ts}
    │   ├── deployments/
    │   │   ├── api/                             # keeps current env-provisioning routes
    │   │   ├── application/
    │   │   │   ├── deployment-provisioning.facade.ts
    │   │   │   ├── deployment-targets.service.ts
    │   │   │   ├── provider-connections.service.ts
    │   │   │   ├── env-vars.service.ts
    │   │   │   ├── project-deployments.service.ts
    │   │   │   ├── project-drift.service.ts
    │   │   │   └── ports/
    │   │   ├── domain/
    │   │   │   ├── deployment-target.ts        # aggregate and lifecycle rules
    │   │   │   ├── provider-connection.ts      # entity rules, never credential I/O
    │   │   │   ├── environment-scope.ts        # lane/branch value object
    │   │   │   └── deployment-target.policy.ts # provider-neutral policy
    │   │   ├── infrastructure/
    │   │   │   ├── repositories/
    │   │   │   └── providers/
    │   │   │       ├── core/{deployment-provider.contract.ts,provider-registry.ts,provider-contract.suite.ts}
    │   │   │       ├── render/
    │   │   │       └── vercel/
    │   │   ├── deployments.module.ts
    │   │   └── index.ts                         # only public deployment facade and contracts
    │   ├── existing-repos/{api,application,existing-repos.module.ts,index.ts}
    │   ├── feedback/{api,application,infra,feedback.module.ts,index.ts}
    │   ├── github/{api,application,infra,workers,github.module.ts,index.ts}
    │   ├── hierarchy/
    │   │   ├── api/
    │   │   ├── application/{assignments,config-broker,delivery-projects,github-sync,groups,project-link,repositories,systems}
    │   │   ├── domain/                          # only membership/lifecycle policies
    │   │   ├── infra/
    │   │   ├── hierarchy.module.ts
    │   │   └── index.ts
    │   ├── notifications/{api,application,infra,notifications.module.ts,index.ts}
    │   ├── projects/
    │   │   ├── api/
    │   │   ├── application/{project-lifecycle.service.ts,project-dashboard.service.ts,project-previews.service.ts,project-workflows.service.ts,project-drift-repair.service.ts,ports}
    │   │   ├── domain/                          # only project status/lifecycle invariants
    │   │   ├── infra/{repositories,clients}
    │   │   ├── projects.module.ts
    │   │   └── index.ts
    │   ├── subscription/{api,application,infra,subscription.module.ts,index.ts}
    │   ├── usage/{api,application,infra,usage.module.ts,index.ts}
    │   ├── workflows/{api,application,domain,infra,workflows.module.ts,index.ts}
    │   └── workspaces/{api,application,domain,infra,workspaces.module.ts,index.ts}
    ├── scripts/
    └── types/

There is no modules/database, modules/persistence, or final
modules/env-provisioning directory. Their existing imports remain available
only through temporary compatibility re-exports while the tasks migrate
callers. The final public boundary is modules/deployments/index.ts.

## Compatibility contract

Before every task, capture the existing behavior and keep it passing after the
move:

- Existing REST paths remain available, including all current env-provisioning,
  project deployment, project drift, CI, and workflow paths.
- Existing PostgreSQL tables, constraints, and migration history remain intact.
- Render and Vercel credentials continue to decrypt and resolve exactly as
  before.
- Existing deployment strategy names, provider URLs, workflow YAML output,
  quota results, and error messages stay unchanged.
- Existing class/module names can remain as compatibility re-exports while
  callers move to their public facades.

## Task 0: Publish the DDD context map before code moves

**Files:**
- Create: docs/architecture/DDD_CONTEXT_MAP.md

**Interfaces:**
- Produces: the approved bounded-context map, ubiquitous language, aggregate
  ownership, and anti-corruption contracts used by every following task.
- Produces no runtime behavior, HTTP contract, database migration, or provider
  change.

- [ ] **Step 1: Write the context map using the vocabulary in this plan.**

    Document Projects, Deployments, CI, Workflows, Usage, and Auth. For each,
    state its aggregate owner, public API, data it may read, and data it may not
    access. Include the ProjectReference, DeploymentTarget, ProviderConnection,
    and EnvironmentScope definitions from the DDD context map section.

- [ ] **Step 2: Review the map against current imports.**

    Confirm that the map calls out the current forbidden dependencies: projects
    to env-provisioning repositories and provider clients, env-provisioning to
    ProjectsRepository, and SessionAuthGuard to UsersRepository. No code or
    test harness exists yet in this task.

- [ ] **Step 3: Commit.**

    Commit message: docs: define bounded contexts and deployment language

## Task 1: Lock the baseline and add characterization coverage

**Files:**
- Modify: .dependency-cruiser.cjs only to add unambiguous architecture rules
- Modify: .dependency-cruiser-known-violations.json only when a violation is removed
- Create: tests/architecture/module-boundaries.spec.ts
- Test: existing tests for every moved file

**Interfaces:**
- Consumes: current dependency-cruiser baseline of 191 violations.
- Produces: local enforcement through npm run boundaries, which ignores only
  the checked-in baseline and fails any new violation.
- Produces: architecture tests that protect public-entry and kernel rules.

- [ ] **Step 1: Write failing architecture assertions.**

    The test must read the dependency-cruiser configuration and assert that
    kernel-to-module imports, circular imports, and cross-module deep imports
    are forbidden. It must assert that the known-violations count is not greater
    than the checked-in baseline count.

- [ ] **Step 2: Run the focused test.**

    Run: npm test -- --runInBand tests/architecture/module-boundaries.spec.ts

    Expected: failure until the test and baseline guard are wired.

- [ ] **Step 3: Require the baseline-aware gate locally before every commit.**

    Run npm run boundaries from the developer workstation after every boundary
    change. It ignores only entries in
    .dependency-cruiser-known-violations.json and fails for every new error.
    Do not change .github/workflows/boundaries.yml while GitHub Actions minutes
    are unavailable. Do not run npm run boundaries:new as a required gate until
    the baseline is empty.

- [ ] **Step 4: Run the gate and characterization tests.**

    Run: npm run boundaries && npm test -- --runInBand tests/architecture/module-boundaries.spec.ts

    Expected: the baseline-aware command passes; the architecture test passes.
    npm run boundaries:new is expected to fail until Task 11 removes every
    known violation.

- [ ] **Step 5: Commit.**

    Commit message: chore: protect architecture boundary baseline

## Task 2: Introduce the env-provisioning deployment public API without moving behavior

**Files:**
- Modify: src/modules/env-provisioning/index.ts
- Modify: src/modules/env-provisioning/env-provisioning.module.ts
- Create: src/modules/env-provisioning/deployment-provisioning.contract.ts
- Test: src/modules/env-provisioning/project-deployment-provisioning.service.spec.ts
- Test: src/modules/env-provisioning/provider-clients/provider-client.registry.spec.ts

**Interfaces:**
- Produces: EnvProvisioningModule, DeploymentProvisioningFacade,
  DeploymentProvisioningRequest, DeploymentProvisioningResult, EnvProvider,
  DeploymentTargetSummary, and providerPublicUrl from index.ts.
- Does not export: repositories, encryption service, registry internals,
  controllers, or HTTP DTOs.

- [ ] **Step 1: Write type-level and module-wiring tests for the public facade.**

    The test must instantiate the existing module and resolve the facade. The
    facade must delegate to the existing ProjectDeploymentProvisioningService
    and return the exact existing result for an enabled request and for a
    skipped request.

- [ ] **Step 2: Run the focused tests.**

    Run: npm test -- --runInBand src/modules/env-provisioning/project-deployment-provisioning.service.spec.ts src/modules/env-provisioning/provider-clients/provider-client.registry.spec.ts

    Expected: passing baseline before refactoring.

- [ ] **Step 3: Add the facade contract and adapter.**

    The contract must be defined in env-provisioning, not projects:

    interface DeploymentProvisioningFacade {
      provisionForProject(input: DeploymentProvisioningRequest): Promise<DeploymentProvisioningResult>;
    }

    The adapter delegates to the existing service. Reuse the existing runtime
    logic and result values exactly; this task introduces no provider branching.

- [ ] **Step 4: Export only the contract, facade token, facade, module, and safe shared types from index.ts.**

    Existing consumers must be able to import the module and facade through
    index.ts. Do not expose deployment target repositories or provider clients.

- [ ] **Step 5: Run focused tests and typecheck.**

    Run: npm test -- --runInBand src/modules/env-provisioning/project-deployment-provisioning.service.spec.ts src/modules/env-provisioning/provider-clients/provider-client.registry.spec.ts && npm run typecheck

    Expected: all tests pass; no behavior assertion changes.

- [ ] **Step 6: Commit.**

    Commit message: refactor: expose deployment provisioning facade

## Task 3: Break the projects and env-provisioning cycle

**Files:**
- Modify: src/modules/projects/projects.service.ts
- Modify: src/modules/projects/projects.module.ts
- Modify: src/modules/env-provisioning/project-deployment-provisioning.service.ts
- Modify: src/modules/env-provisioning/env-provisioning.module.ts
- Modify: .dependency-cruiser-known-violations.json
- Test: src/modules/projects/projects.service.spec.ts
- Test: src/modules/env-provisioning/project-deployment-provisioning.service.spec.ts

**Interfaces:**
- Consumes: DeploymentProvisioningFacade from env-provisioning/index.ts.
- Produces: no import from env-provisioning to projects, and no projects-to-env
  repository import for project setup provisioning.
- Produces: one-way Nest composition: EnvProvisioningModule exports the facade
  token and ProjectsModule imports that public module API. EnvProvisioningModule
  does not import ProjectsModule, ProjectsRepository, project DTOs, or
  ProjectsService.

- [ ] **Step 1: Add regression assertions around project setup provisioning.**

    Cover the existing completed, partial, failed, and skipped provisioning
    outcomes. Assert the existing ProjectsService response remains byte-for-byte
    equivalent at the object level. Use Jest invocation ordering assertions to
    record the current sequence of project persistence, GitHub workflow write,
    CI-secret installation, and provider provisioning calls. Add a repeated
    request test that records the current idempotency/retry behavior; this plan
    must preserve it rather than introduce retry logic.

- [ ] **Step 2: Run the regression tests.**

    Run: npm test -- --runInBand src/modules/projects/projects.service.spec.ts src/modules/env-provisioning/project-deployment-provisioning.service.spec.ts

    Expected: passing baseline.

- [ ] **Step 3: Move request and result types to deployment-provisioning.contract.ts.**

    ProjectsService imports the facade and contract from env-provisioning/index.ts.
    The env-provisioning implementation must no longer import a projects DTO or
    ProjectsService type. Convert inputs at the projects application boundary.

- [ ] **Step 4: Replace direct provider registration with the exported facade.**

    ProjectsModule imports EnvProvisioningModule through its public index. It
    injects the facade token; it does not inject ProjectDeploymentProvisioningService
    directly.

- [ ] **Step 5: Remove the cycle entry only after the dependency graph is clean.**

    Run: npm run boundaries

    Expected: the projects/env-provisioning cycle is absent and no new
    violation appears. Delete exactly its baseline entry; do not edit unrelated
    entries.

- [ ] **Step 6: Run project and deployment tests, then commit.**

    Run: npm test -- --runInBand src/modules/projects/projects.service.spec.ts src/modules/env-provisioning/project-deployment-provisioning.service.spec.ts && npm run boundaries && npm run typecheck

    Commit message: refactor: decouple projects from deployment provisioning

## Task 4: Create kernel database and authentication contracts

**Files:**
- Create: src/kernel/db/database.module.ts
- Create: src/kernel/db/database.service.ts
- Create: src/kernel/db/postgres-ssl.config.ts
- Create: src/kernel/auth/session-user-lookup.contract.ts
- Move: src/modules/database/database.module.ts to src/kernel/db/database.module.ts
- Move: src/modules/database/database.service.ts to src/kernel/db/database.service.ts
- Move: src/modules/database/postgres-ssl.config.ts to src/kernel/db/postgres-ssl.config.ts
- Modify: src/common/guards/session-auth.guard.ts
- Modify: imports in every repository using DatabaseService
- Test: existing database, SSL, and SessionAuthGuard tests

**Interfaces:**
- Produces: DatabaseModule and DatabaseService from kernel/db.
- Produces: SESSION_USER_LOOKUP token and SessionUserLookup interface from
  kernel/auth.
- The guard consumes SessionUserLookup; it no longer imports UsersRepository.

- [ ] **Step 1: Capture existing database and session guard behavior.**

    Run: npm test -- --runInBand src/modules/database/database.service.spec.ts src/modules/database/postgres-ssl.config.spec.ts src/common/guards/session-auth.guard.spec.ts

    Expected: passing baseline.

- [ ] **Step 2: Move database files without changing exported class names or implementation.**

    Update only import paths and Nest module imports. The database service
    constructor, pool configuration, SSL behavior, and error strings must remain
    unchanged.

- [ ] **Step 3: Introduce the kernel token and auth-owned adapter.**

    Define:

    interface SessionUserLookup {
      findSessionUser(userId: string): Promise<SessionUser | null>;
    }

    Auth provides the adapter using its user repository. SessionAuthGuard injects
    the token rather than a concrete repository.

- [ ] **Step 4: Run focused tests and architecture gate.**

    Run: npm test -- --runInBand src/modules/database src/common/guards/session-auth.guard.spec.ts && npm run boundaries && npm run typecheck

    Expected: unchanged guard behavior and no kernel-to-module import.

- [ ] **Step 5: Commit.**

    Commit message: refactor: move database and auth contracts to kernel

## Task 5: Dissolve PersistenceModule by repository ownership

**Files:**
- Move: src/modules/persistence/users.repository.ts to src/modules/auth/infra/users.repository.ts
- Move: src/modules/persistence/oauth-state.repository.ts to src/modules/auth/infra/oauth-state.repository.ts
- Move: src/modules/persistence/subscriptions.repository.ts to src/modules/subscription/infra/subscriptions.repository.ts
- Move: src/modules/persistence/workflow-history.repository.ts to src/modules/workflows/infra/workflow-history.repository.ts
- Move: src/modules/ci/ci-tokens.repository.ts to src/modules/ci/infra/ci-tokens.repository.ts
- Move: src/modules/persistence/outbox.repository.ts to src/kernel/events/outbox.repository.ts only if its consumers remain cross-module
- Delete: src/modules/persistence/persistence.module.ts after the final consumer moves
- Modify: owning Nest modules, public indexes, imports, and matching specs

**Interfaces:**
- Each owning module exports an application facade when another module needs
  behavior; it does not export the moved repository.
- CI exposes a CiTokenStatusLookup facade only if another module still needs
  token status.

- [ ] **Step 1: Move one repository owner at a time, beginning with CI tokens.**

    Before each move, run that repository's existing spec. After the move, run
    the same spec and update only imports/module wiring.

- [ ] **Step 2: Move auth, subscription, and workflow repositories with their specs.**

    Keep SQL, row mapping, return types, and error handling identical. No
    migration is created in this task.

- [ ] **Step 3: Decide outbox ownership from actual consumers.**

    Keep it in kernel/events only if more than one module writes or relays it.
    If only one remains, move it to that module instead. Record the decision in
    the module README or architecture review.

- [ ] **Step 4: Delete PersistenceModule and its last baseline entries.**

    Run: npm run boundaries && npm test -- --runInBand src/modules/auth src/modules/subscription src/modules/workflows src/modules/ci

    Expected: no import from modules/persistence remains.

- [ ] **Step 5: Commit.**

    Commit message: refactor: assign persistence adapters to feature owners

## Task 6: Modularize provider adapters inside env-provisioning

**Files:**
- Create: src/modules/env-provisioning/application/ports/deployment-provider.port.ts
- Create: src/modules/env-provisioning/infrastructure/providers/core/provider-contract.suite.ts
- Move: src/modules/env-provisioning/provider-clients to src/modules/env-provisioning/infrastructure/providers
- Move: provider-facing services and repositories into application and infrastructure subdirectories
- Modify: src/modules/env-provisioning/env-provisioning.module.ts, index.ts, imports, and specs

**Interfaces:**
- Env-provisioning is the temporary canonical module name in this task; all
  existing HTTP paths, class names, injection tokens, provider IDs, and config
  keys stay unchanged.
- Render and Vercel implement DeploymentProvider. A provider adapter may import
  provider contracts and kernel technical types, but never another provider
  adapter, an API controller, or a projects internal file.

- [ ] **Step 1: Characterize provider and side-effect behavior.**

    Run: npm test -- --runInBand src/modules/env-provisioning/provider-clients src/modules/env-provisioning/deployment-targets.service.spec.ts src/modules/env-provisioning/env-vars.service.spec.ts

    Add assertions for connection validation, managed and BYO credential
    selection, public URL resolution, provider error normalization, and
    environment-variable write/delete outcomes for both Render and Vercel.

- [ ] **Step 2: Move files only within env-provisioning.**

    Move provider clients to infrastructure/providers and use import updates
    only. Keep controller route decorators, service method names, SQL, provider
    payloads, encryption, and dependency-injection tokens unchanged.

- [ ] **Step 3: Add focused layer rules after the folders exist.**

    Extend .dependency-cruiser.cjs with rules that reject:
    domain files importing @nestjs, pg, @supabase, api, or infrastructure;
    api files importing an infrastructure repository or provider adapter; and
    one provider adapter importing another provider adapter. The rules must
    apply only to the new env-provisioning paths and must not add known
    violations.

- [ ] **Step 4: Extract provider contracts and conformance tests without adding a provider.**

    The contract covers the existing operations: connection validation, target
    lifecycle, environment variable synchronization, public/dashboard URLs,
    CI secret installation, and deployment history. Render and Vercel must pass
    the same contract suite with their existing behavior.

- [ ] **Step 5: Run provider, project setup, and boundary checks.**

    Run: npm test -- --runInBand src/modules/env-provisioning src/modules/projects/projects.service.spec.ts && npm run boundaries && npm run typecheck

    Expected: unchanged Render/Vercel behavior and no layer-rule violation.

- [ ] **Step 6: Commit.**

    Commit message: refactor: isolate deployment provider adapters

## Task 7: Move deployment reads and drift behind env-provisioning facades

**Files:**
- Move: src/modules/projects/project-deployments.service.ts to src/modules/env-provisioning/application/project-deployments.service.ts
- Move: src/modules/projects/project-drift.service.ts to src/modules/env-provisioning/application/project-drift.service.ts
- Move: deployment-specific types to src/modules/env-provisioning/application
- Modify: src/modules/env-provisioning/index.ts, projects controllers/services, modules, and tests

**Interfaces:**
- Env-provisioning exports DeploymentHistoryQuery and DeploymentDriftQuery
  facade tokens and result types through index.ts.
- Projects authorizes access to its ProjectReference before calling either
  facade. Env-provisioning accepts that reference and must not inject
  ProjectsRepository, ProjectsService, project DTOs, or project database rows.

- [ ] **Step 1: Add regression tests for live, unavailable, and local-mock deployment history modes.**

    Assert existing mode names, status normalization, error-message sanitation,
    sorting, provider URL selection, and current project authorization result.

- [ ] **Step 2: Move the services behind exported facades.**

    Project controllers retain their current paths and response mappings. The
    controller or project application service resolves authorization first, then
    passes ProjectReference and user identity to the deployment facade.

- [ ] **Step 3: Remove all project deep imports into env-provisioning.**

    Replace DeploymentTargetsRepository, EnvVarsRepository,
    EnvTokenEncryptionService, and ProviderClientRegistry imports in projects
    with the exported query facades. Remove only the corresponding baseline
    entries after npm run boundaries stays green.

- [ ] **Step 4: Run tests and commit.**

    Run: npm test -- --runInBand src/modules/projects/project-deployments.service.spec.ts src/modules/projects/project-drift.service.spec.ts src/modules/env-provisioning && npm run boundaries && npm run typecheck

    Commit message: refactor: isolate deployment reads and drift ownership

## Task 8: Canonicalize env-provisioning as deployments

**Files:**
- Move: src/modules/env-provisioning to src/modules/deployments
- Modify: src/app.module.ts, every module public index import, Nest module
  imports, tests, and dependency-cruiser path rules
- Rename: EnvProvisioningModule to DeploymentsModule only after all source
  callers use the public API

**Interfaces:**
- The externally observable controller paths remain unchanged.
- The final source boundary is src/modules/deployments/index.ts.
- No source compatibility directory remains after this task; all in-repository
  callers must have been migrated before the move.

- [ ] **Step 1: Prove no internal caller depends on the old private paths.**

    Run: rg -n "modules/env-provisioning|../env-provisioning/" src tests

    Expected: only the final controlled module/public-index imports remain
    before the mechanical move.

- [ ] **Step 2: Move the folder and update public module imports in one commit.**

    Preserve every controller decorator and route prefix. Do not change SQL,
    provider configuration names, dependency-injection token values, or
    response types while moving files.

- [ ] **Step 3: Run deployment, project, type, and boundary verification.**

    Run: npm test -- --runInBand src/modules/deployments src/modules/projects && npm run boundaries && npm run typecheck

    Expected: no source import mentions env-provisioning and all route behavior
    remains covered by the existing controller tests.

- [ ] **Step 4: Commit.**

    Commit message: refactor: rename env provisioning module to deployments

## Task 9: Split ProjectsService by workflow without changing its public API

**Files:**
- Create: src/modules/projects/application/project-lifecycle.service.ts
- Create: src/modules/projects/application/project-dashboard.service.ts
- Create: src/modules/projects/application/project-workflows.service.ts
- Create: src/modules/projects/application/project-previews.service.ts
- Create: src/modules/projects/application/project-drift-repair.service.ts
- Modify: src/modules/projects/projects.service.ts
- Modify: src/modules/projects/projects.module.ts
- Test: src/modules/projects/projects.service.spec.ts and extracted service specs

**Interfaces:**
- ProjectsService remains a compatibility facade until all controllers and
  consumers are moved.
- Each extracted service owns one existing group of methods and reuses the
  current project repository types.

- [ ] **Step 1: Start with one coherent behavior group and move its existing tests unchanged.**

    Choose dashboard/snapshot queries first because they are read-focused and
    have fewer external side effects.

- [ ] **Step 2: Extract the minimal application service.**

    Move the existing methods and dependencies verbatim. Do not rename response
    types or change exception handling in the same commit.

- [ ] **Step 3: Delegate from the compatibility facade.**

    ProjectsService forwards the existing method call to the new service so
    controllers and callers preserve their behavior during the migration.

- [ ] **Step 4: Repeat one workflow group per commit.**

    Order: dashboard, previews, workflow updates, lifecycle/setup, drift repair.
    Run affected specs before every commit.

- [ ] **Step 5: Verify the complete projects suite.**

    Run: npm test -- --runInBand src/modules/projects && npm run typecheck

    Expected: all existing project behavior passes with smaller focused services.

## Task 10: Finish module public APIs and correct layer names

**Files:**
- Create or modify: src/modules/*/index.ts for every feature module
- Move: src/modules/notifications/domain to src/modules/notifications/application
- Modify: all cross-module imports and Nest module imports
- Modify: .dependency-cruiser-known-violations.json as entries are removed
- Test: notifications specs and affected module specs

**Interfaces:**
- Each index.ts exports the module, a narrowly scoped facade/token, and public
  contract types.
- No index.ts exports a controller, repository, internal client, or feature DTO.

- [ ] **Step 1: Add index.ts files for simple one-way dependencies first.**

    Start with audit, subscription, usage, workspaces, catalog, CI, and GitHub.
    Convert one consuming module at a time and delete matching baseline entries.

- [ ] **Step 2: Rename notifications/domain to notifications/application.**

    Update imports only. Preserve the existing Nest services and repository
    behavior; do not invent a domain layer.

- [ ] **Step 3: Run the boundary gate after each module conversion.**

    Run: npm run boundaries && npm test -- --runInBand src/modules/notifications

    Expected: the known baseline shrinks and does not grow.

- [ ] **Step 4: Commit each independent module boundary.**

    Commit message pattern: refactor: expose <module> public API

## Task 11: Close the baseline and perform release-equivalence verification

**Files:**
- Modify: .dependency-cruiser-known-violations.json until empty
- Modify: docs/architecture/BACKEND_ARCHITECTURE_ALIGNMENT_REVIEW.md with final baseline count and final module tree
- Test: all unit, integration, E2E, lint, build, typecheck, and boundary commands

**Interfaces:**
- Produces: zero known boundary violations and a documented modular-monolith
  architecture ready for future provider and service-extraction work.

- [ ] **Step 1: Remove the final known violation only with a corresponding code change.**

    Do not delete entries pre-emptively. Every removed entry must be absent from
    npm run boundaries:new output.

- [ ] **Step 2: Run the complete validation suite locally.**

    Run: npm run lint && npm run typecheck && npm test -- --runInBand && npm run test:e2e && npm run build && npm run boundaries:new

    Expected: all commands pass locally; dependency-cruiser reports zero
    findings. GitHub Actions is intentionally not a validation dependency.

- [ ] **Step 3: Review observable behavior before merge.**

    Compare generated workflow fixtures, project setup responses, deployment
    history responses, drift responses, auth/session behavior, and Render/Vercel
    provider contract results against their pre-refactor tests. Any difference
    blocks this plan and becomes a separate behavior-change proposal.

- [ ] **Step 4: Commit.**

    Commit message: refactor: complete modular monolith boundary restoration

## Plan self-review

- Coverage: every agreed change is covered: kernel boundaries, persistence
  ownership, public APIs, the projects/deployments cycle, deployment-provider
  modularity, staged deployments rename, projects workflow extraction,
  notifications layer correction, layer-boundary enforcement, side-effect
  characterization, and zero-boundary verification.
- Scope: the plan deliberately excludes GCP delivery, API expansion, database
  schema redesign, and service extraction because each changes behavior or
  operational scope.
- Compatibility: every task requires existing tests to remain green and retains
  current HTTP/database/provider behavior.
