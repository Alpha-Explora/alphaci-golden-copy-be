# Task 8.1 runtime move record

This is the pre-move composition inventory required by the consolidation plan.
The physical `deployments` module becomes `runtime`; behavior and provider
implementations move verbatim.

## Incoming composition edges

| Current wiring | After the move |
|---|---|
| `app.module.ts -> DeploymentsCoreModule` | remains root wiring; runtime core registry is composed once |
| `app.module.ts -> GcpDeploymentModule` | remains root wiring; GCP provider is runtime-internal wiring after the fold |
| `app.module.ts -> DeploymentsModule` | becomes `RuntimeModule` |
| `projects.module.ts -> DeploymentsModule` | becomes the single projects-to-runtime module edge |
| `capabilities.module.ts -> DeploymentsCoreModule` | remains discovery wiring through the runtime registry |
| `usage` imports deployment usage contracts | becomes billing-to-runtime contract traffic |
| projects imports deployment public index | becomes projects-to-runtime public contract traffic |

## Arrival normalization

- `presentation/` becomes `api/`.
- `infrastructure/` remains `infrastructure/`.
- `project-sync-findings.repository.ts` lives under
  `infrastructure/repositories/`.
- Provider folders under `infrastructure/providers/` move unchanged.
- All local imports are updated to `#modules/runtime`; no compatibility shim
  is retained because every in-repository caller is migrated in this PR.

## Verification contract

Before and after metrics are captured in the task log. The PR must pass
typecheck, lint, full Jest, strict dependency boundaries, application
boundaries, provider encapsulation, Nest build, and the minimum boot command.
