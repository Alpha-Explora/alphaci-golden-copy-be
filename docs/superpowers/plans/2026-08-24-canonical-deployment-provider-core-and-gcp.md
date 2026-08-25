# Canonical Deployment Provider Core and GCP Implementation Plan

> **For agentic workers:** Execute one task at a time. Keep every pull request independently deployable, preserve the existing Render/Vercel API behavior, and do not create or alter live Google Cloud resources while developing or verifying this work.

**Goal:** Replace the provider-specific deployment provisioning seams with one canonical provider core, migrate the existing Render and Vercel implementations behind adapters without changing their behavior, and add GCP Cloud Run as the first new, configuration-selected provider.

**Architecture:** `src/modules/deployments/core` owns generic contracts, registry lookup, persistence-facing DTOs, discovery, safe errors, and conformance tests. Render, Vercel, and GCP live in isolated provider modules that depend on core but never on each other. Existing public deployment, connection, and environment-variable routes remain stable while their implementations are moved behind the core; `GET /api/v1/deployment-providers` is the only new general route. GCP reuses the proven `alphaci-be` adapter/orchestrator patterns, but remains mock-verified only.

**Tech Stack:** NestJS 11, TypeScript, PostgreSQL/Supabase migrations, `google-auth-library`, Jest, Next.js App Router, React, GitHub Actions workflow YAML.

## Global Constraints

- Do not commit, push, apply migrations, or call live Google Cloud APIs while executing this plan.
- Create the implementation in an isolated `codex/` branch/worktree; open a PR to `main` only after all planned verification passes and the owners review their provider adapters.
- Preserve the current public paths, response compatibility, guards, and Render/Vercel behavior. `POST /provider-connections` must accept legacy `{ token }` while adding `{ credential }`.
- New database changes are additive. Keep legacy `render_*`, `encrypted_token`, and `token_last_four` columns until a separately approved cleanup migration.
- Core never inspects a provider credential. It encrypts/decrypts an opaque object and passes it to the owning provider.
- A provider is an installed Nest module selected by configuration; do not dynamically load third-party code at runtime.
- GCP tests use the fake adapter and mocked HTTP/auth clients only. No test may use production/shared-staging credentials, Terraform apply, or a real GCP project.
- Provider folders may import from `deployments/core`; core may not import from providers; provider folders may not import from each other.

---

## Delivery and ownership map

| PR | Deliverable | Required reviewers |
| --- | --- | --- |
| 1 | Provider core and provider-neutral persistence | Core owner + database reviewer |
| 2 | Render/Vercel behavior-preserving adapters and workflow inversion | Render/Vercel owner |
| 3 | GCP Cloud Run provider, queue, and configuration | GCP owner |
| 4 | Data-driven frontend provider discovery and forms | Frontend owner |

The four PRs merge in order. PR 2 may be split into Render and Vercel adapter PRs after PR 1, but both must pass the unchanged existing provider suites before PR 3 or PR 4 changes production selection.

## Target module boundary

```text
src/modules/deployments/
  core/
    deployment-provider.contract.ts
    deployment-provider.registry.ts
    deployment-provider.tokens.ts
    deployment-provider.errors.ts
    deployment-config.types.ts
    deployments.service.ts
    deployments.controller.ts
    deployment-providers.controller.ts
    dto/create-deployment-target.dto.ts
    dto/create-provider-connection.dto.ts
    testing/provider-contract.suite.ts
  providers/
    render/{render.provider.ts,render.client.ts,render.workflow.ts,render.module.ts,index.ts}
    vercel/{vercel.provider.ts,vercel.client.ts,vercel.workflow.ts,vercel.module.ts,index.ts}
    gcp/{gcp.provider.ts,gcp-runtime.port.ts,google-cloud-runtime.adapter.ts,
         fake-gcp-runtime.adapter.ts,gcp-provisioning-orchestrator.service.ts,
         gcp-deployment-targets.repository.ts,provisioning-jobs.repository.ts,
         gcp.config.ts,gcp.workflow.ts,gcp.module.ts,index.ts}
  deployments.module.ts
```

## Task 1: Establish the provider core and discovery contract

**Files:**

- Create: `src/modules/deployments/core/deployment-provider.contract.ts`
- Create: `src/modules/deployments/core/deployment-provider.registry.ts`
- Create: `src/modules/deployments/core/deployment-provider.tokens.ts`
- Create: `src/modules/deployments/core/deployment-provider.errors.ts`
- Create: `src/modules/deployments/core/deployment-config.types.ts`
- Create: `src/modules/deployments/core/testing/provider-contract.suite.ts`
- Create: `src/modules/deployments/core/deployment-providers.controller.ts`
- Create: `src/modules/deployments/core/deployment-providers.controller.spec.ts`
- Create: `src/modules/deployments/deployments.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/config/app.config.ts`
- Modify: `.dependency-cruiser.cjs`
- Modify: `.github/CODEOWNERS`

**Interfaces:**

```ts
export interface ProviderCapabilities {
  envVars: boolean;
  logs: boolean;
  deployHistory: boolean;
  teardown: boolean;
  managedMode: boolean;
  liveStatus: boolean;
  connectivity: 'direct' | 'indirect';
  enumerable: boolean;
  credentialCustody: 'platform' | 'external';
}

export interface DeploymentProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  readonly supportedSlots: readonly string[];
  readonly configSchema: ProviderFormSchema;
  readonly credentialSchema: ProviderFormSchema;
  isEnabled(): { enabled: boolean; reason?: string };
  validateConfig(config: Record<string, unknown>): void;
}

export const DEPLOYMENT_PROVIDER = Symbol('DEPLOYMENT_PROVIDER');
```

- [ ] **Step 1: Write failing registry and discovery-controller tests**

Create fakes for two `DeploymentProvider` objects. Assert that `registry.get('gcp')` returns the GCP fake, an unknown id raises a stable bad-request error, and discovery returns only installed providers with their enabled state and form schemas.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- --runInBand src/modules/deployments/core/deployment-providers.controller.spec.ts`

Expected: FAIL because the core directory and registry do not exist.

- [ ] **Step 3: Implement the minimal core**

Implement a map-backed `DeploymentProviderRegistry`; reject duplicate provider ids during construction. Add `DEPLOYMENT_PROVIDER` as a multi-provider token. Make `DeploymentProvidersController` return `{ providers: registry.list().map(toDiscoveryView) }`, with no credentials or provider-internal config values.

Add `DEPLOY_PROVIDERS_ENABLED` parsing to `app.config.ts` as a comma-separated allow-list. Provider `isEnabled()` must require both the global env-provisioning flag and its own configuration to be valid.

- [ ] **Step 4: Enforce the boundary**

Add dependency-cruiser/ESLint restrictions so `deployments/core/**` cannot import `deployments/providers/**`, and a provider folder cannot import another provider folder. Add `.github/CODEOWNERS` entries with real GitHub handles supplied by the repository owners before the PR is opened.

- [ ] **Step 5: Run focused verification**

Run:

```powershell
npm test -- --runInBand src/modules/deployments/core/deployment-providers.controller.spec.ts
npm run typecheck
npm run boundaries
```

Expected: PASS. Leave all changes unstaged and uncommitted.

## Task 2: Make persistence and credentials provider-neutral without data loss

**Files:**

- Create: `supabase/migrations/20260825000000_deployment_provider_plugins.sql`
- Create: `supabase/rollbacks/20260825000000_deployment_provider_plugins_down.sql`
- Create: `scripts/migrate-provider-credentials.mjs`
- Create: `scripts/migrate-provider-credentials.spec.mjs`
- Modify: `src/modules/env-provisioning/encryption.service.ts`
- Modify: `src/modules/env-provisioning/provider-connections.repository.ts`
- Modify: `src/modules/env-provisioning/provider-connections.service.ts`
- Modify: `src/modules/env-provisioning/provider-connections.controller.ts`
- Modify: `src/modules/env-provisioning/dto/create-provider-connection.dto.ts`
- Modify: `src/modules/env-provisioning/deployment-targets.repository.ts`
- Modify: `src/modules/env-provisioning/env-provisioning.types.ts`
- Modify: `src/modules/env-provisioning/*.{spec.ts}` for the affected repository/service/controller suites

**Interfaces:**

```ts
export type ProviderCredential = Record<string, unknown>;

export class CreateProviderConnectionDto {
  provider!: string;
  label!: string;
  credential?: ProviderCredential;
  token?: string; // deprecated compatibility alias
}

// Core maps legacy token only when credential is absent.
const normalizedCredential = dto.credential ?? (dto.token ? { token: dto.token } : undefined);
```

- [ ] **Step 1: Write failing compatibility tests**

Cover all of the following before changing persistence:

1. Existing Render/Vercel token payloads still create a connection.
2. A provider-specific credential object is encrypted and never returned in a list response.
3. An unknown provider and a disabled provider are rejected through the registry.
4. Existing target rows deserialize with an empty `providerConfig` when the new column is absent from an older row.

- [ ] **Step 2: Add the expand-only migration**

The migration must:

1. Add `provider_config JSONB NOT NULL DEFAULT '{}'::jsonb` to `env_provisioning.project_deployment_targets`.
2. Add nullable `encrypted_credential` and `credential_hint` to `env_provisioning.provider_connections`.
3. Add `env_provisioning.deployment_providers(id TEXT PRIMARY KEY, label TEXT NOT NULL)` and seed `render`, `vercel`, and `gcp`.
4. Replace only the closed `provider` checks with foreign keys to the registry table on targets, connections, and env metadata; retain all legacy columns.
5. Add `provisioning` to the deployment-target status constraint.

The rollback reverses only the new constraints/tables/columns when safe; it must not delete migrated credentials or legacy provider data.

- [ ] **Step 3: Implement credential encryption migration support**

Extend `EnvTokenEncryptionService` with typed `encryptCredential` and `decryptCredential` methods that JSON-serialize only `Record<string, unknown>` inputs. Keep the old token helpers as wrappers around `{ token }` until the cleanup migration.

`scripts/migrate-provider-credentials.mjs` must be explicitly opt-in with `--execute`, default to dry-run, read encrypted legacy values, re-encrypt `{ token: decryptedValue }`, and print counts only—never values or ciphertext.

- [ ] **Step 4: Run mock-only migration and repository verification**

Run:

```powershell
npm test -- --runInBand src/modules/env-provisioning/encryption.service.spec.ts src/modules/env-provisioning/provider-connections.repository.spec.ts src/modules/env-provisioning/provider-connections.service.spec.ts
node scripts/migrate-provider-credentials.mjs --dry-run
```

Expected: PASS; the script must refuse to execute without `--execute` and must not contact any cloud provider.

## Task 3: Migrate Render and Vercel behind adapters with no behavior change

**Files:**

- Create: `src/modules/deployments/providers/render/render.provider.ts`
- Create: `src/modules/deployments/providers/render/render.client.ts`
- Create: `src/modules/deployments/providers/render/render.workflow.ts`
- Create: `src/modules/deployments/providers/render/render.module.ts`
- Create: `src/modules/deployments/providers/render/render.provider.spec.ts`
- Create: `src/modules/deployments/providers/vercel/vercel.provider.ts`
- Create: `src/modules/deployments/providers/vercel/vercel.client.ts`
- Create: `src/modules/deployments/providers/vercel/vercel.workflow.ts`
- Create: `src/modules/deployments/providers/vercel/vercel.module.ts`
- Create: `src/modules/deployments/providers/vercel/vercel.provider.spec.ts`
- Modify: `src/modules/env-provisioning/provider-clients/render-env.client.ts`
- Modify: `src/modules/env-provisioning/provider-clients/vercel-env.client.ts`
- Modify: `src/modules/env-provisioning/provider-clients/provider-client.registry.ts`
- Modify: `src/modules/env-provisioning/deployment-strategy.resolver.ts`
- Modify: `src/modules/env-provisioning/render-ci-secrets.service.ts`
- Modify: `src/modules/env-provisioning/vercel-ci-secrets.service.ts`
- Modify: `src/modules/env-provisioning/env-provisioning.module.ts`
- Modify: all existing focused Render/Vercel specs only where imports move; assertions must remain unchanged

**Interfaces:**

```ts
export interface DeploymentProvider extends ProviderMetadata {
  resolveStrategy(input: ResolveStrategyInput): string;
  createClient(credential: ProviderCredential | null): ProviderRuntimeClient;
  installCiSecrets(input: InstallCiSecretsInput): Promise<void>;
  buildDeployJob(input: BuildDeployJobInput): WorkflowJob | null;
  getPublicUrl(target: ProviderTargetRecord): string | null;
}
```

- [ ] **Step 1: Add conformance cases before moving production code**

Use `provider-contract.suite.ts` for both adapters. Assert stable provider id, supported slots, disabled behavior, config validation, strategy selection, error normalization, and `buildDeployJob` returning a deterministic job for existing fixture targets.

- [ ] **Step 2: Wrap existing clients instead of rewriting HTTP behavior**

Move only module ownership/imports first. `RenderDeploymentProvider` delegates to the existing Render client, cost policy, and CI-secret service. `VercelDeploymentProvider` delegates to the existing Vercel client and secret service. Translate errors at the adapter boundary into `ProviderError`; do not change retry logic, provider endpoints, or request payloads in this PR.

- [ ] **Step 3: Replace the old two-provider switch and strategy resolver**

Change callers to request `deploymentProviderRegistry.get(provider)`. Move Render/Vercel strategy rules into their adapters, then remove the old `if (provider === ...)` execution path only after equivalent unit suites pass. Keep public controller method signatures and guards unchanged.

- [ ] **Step 4: Verify behavior parity**

Run:

```powershell
npm test -- --runInBand src/modules/env-provisioning/provider-clients src/modules/env-provisioning/deployment-strategy.resolver.spec.ts src/modules/env-provisioning/deployment-targets.service.spec.ts src/modules/deployments/providers
npm run typecheck
```

Expected: PASS. Any changed assertion beyond imports/contract shape is a behavior-drift investigation, not an automatic test update.

## Task 4: Route orchestration and generated workflows through the provider core

**Files:**

- Create: `src/modules/deployments/core/deployments.service.ts`
- Create: `src/modules/deployments/core/deployments.controller.ts`
- Create: `src/modules/deployments/core/dto/create-deployment-target.dto.ts`
- Create: `src/modules/deployments/core/deployments.service.spec.ts`
- Modify: `src/modules/env-provisioning/deployment-targets.controller.ts`
- Modify: `src/modules/env-provisioning/deployment-targets.service.ts`
- Modify: `src/modules/env-provisioning/project-deployment-provisioning.service.ts`
- Modify: `src/modules/env-provisioning/env-vars.service.ts`
- Modify: `src/modules/projects/dto/create-project.dto.ts`
- Modify: `src/modules/projects/projects.service.ts`
- Modify: `src/modules/workflows/dto/generate-workflow.dto.ts`
- Modify: `src/modules/workflows/staged-workflow.builder.ts`
- Modify: `src/modules/capabilities/capabilities.controller.ts`
- Modify: `src/modules/usage/usage-quota.service.ts`
- Modify: their existing `.spec.ts` files

**Interfaces:**

```ts
export class CreateDeploymentTargetDto {
  provider!: string;
  slot!: string;
  ownershipMode!: 'byo' | 'flowci_managed';
  config!: Record<string, unknown>;
}

function buildPackageDeploymentPlan(
  targets: readonly DeploymentWorkflowTarget[],
  registry: DeploymentProviderRegistry,
): { jobs: Record<string, WorkflowJob>; jobIds: string[] };
```

- [ ] **Step 1: Lock route and guard compatibility in controller specs**

Add tests proving that `SessionAuthGuard`, `SubscriptionGuard`, and `EnvFeatureGuard` remain attached to each existing deployment/connection/env-var route. Cover old target payloads and the generic `{ provider, slot, ownershipMode, config }` payload mapping to the same service result.

- [ ] **Step 2: Make core the only dispatch point**

`DeploymentsService` validates the provider and configuration, resolves the adapter, and delegates create/update/sync/actions/log calls. Existing controllers delegate to it; preserve their URLs and response shapes. `CapabilitiesController` derives its provider list from the registry rather than a literal array.

- [ ] **Step 3: Invert workflow generation**

Replace the Render/Vercel branches in `buildPackageDeploymentPlan` with `registry.get(target.provider).buildDeployJob(target, context)`. Move existing YAML builders verbatim into the Render/Vercel provider workflow files first; add no GCP workflow job until Task 5. Change `secretNames` to `Record<string, string>` so core never enumerates provider-specific keys.

- [ ] **Step 4: Remove remaining central provider switches**

Use `rg` to verify no provider-specific control flow remains outside a provider folder, approved compatibility mapper, migration, or test fixture:

```powershell
rg -n "provider === '(render|vercel)'|\['render', 'vercel'\]|'render' \| 'vercel'" src
```

For every production match, either move it to the owning provider or document why it is an intentional temporary compatibility boundary.

- [ ] **Step 5: Run backend regression suites**

Run:

```powershell
npm test -- --runInBand src/modules/workflows src/modules/projects src/modules/env-provisioning src/modules/capabilities src/modules/usage src/modules/deployments
npm run lint
npm run typecheck
```

Expected: PASS with no provider network calls.

## Task 5: Add the GCP Cloud Run provider from the sibling implementation

**Files:**

- Create: `src/modules/deployments/providers/gcp/gcp-runtime.port.ts`
- Create: `src/modules/deployments/providers/gcp/google-cloud-runtime.adapter.ts`
- Create: `src/modules/deployments/providers/gcp/fake-gcp-runtime.adapter.ts`
- Create: `src/modules/deployments/providers/gcp/gcp-deployment-targets.repository.ts`
- Create: `src/modules/deployments/providers/gcp/provisioning-jobs.repository.ts`
- Create: `src/modules/deployments/providers/gcp/gcp-provisioning-orchestrator.service.ts`
- Create: `src/modules/deployments/providers/gcp/gcp.provider.ts`
- Create: `src/modules/deployments/providers/gcp/gcp.config.ts`
- Create: `src/modules/deployments/providers/gcp/gcp.workflow.ts`
- Create: `src/modules/deployments/providers/gcp/gcp.module.ts`
- Create: `src/modules/deployments/providers/gcp/*.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `src/config/app.config.ts`
- Modify: `src/modules/deployments/deployments.module.ts`
- Modify: `src/app.module.ts`

**Reference source:** Adapt, do not blindly copy, these sibling files:

- `C:/Users/anton/Codes/Alpha Explora/AlphaCi/alphaci-be/apps/customer-runtime/src/application/ports/gcp-runtime.port.ts`
- `C:/Users/anton/Codes/Alpha Explora/AlphaCi/alphaci-be/apps/customer-runtime/src/infrastructure/adapters/google-cloud-runtime.adapter.ts`
- `C:/Users/anton/Codes/Alpha Explora/AlphaCi/alphaci-be/apps/customer-runtime/src/infrastructure/adapters/fake-gcp-runtime.adapter.ts`
- `C:/Users/anton/Codes/Alpha Explora/AlphaCi/alphaci-be/apps/customer-runtime/src/application/gcp-provisioning-orchestrator.service.ts`
- `C:/Users/anton/Codes/Alpha Explora/AlphaCi/alphaci-be/apps/customer-runtime/src/infrastructure/deployment-targets-gcp.repository.ts`
- `C:/Users/anton/Codes/Alpha Explora/AlphaCi/alphaci-be/apps/customer-runtime/src/infrastructure/provisioning-jobs.repository.ts`

- [ ] **Step 1: Add GCP dependencies and disabled-by-default configuration**

Add `google-auth-library`. Add these validated settings, all disabled/empty by default:

```text
GCP_DEPLOYMENTS_ENABLED=false
GCP_SHARED_PROJECT_ID=
GCP_REGION=asia-southeast1
GCP_ARTIFACT_REGISTRY_REPOSITORY=
GCP_WORKLOAD_IDENTITY_PROVIDER=
GCP_DEPLOYER_SERVICE_ACCOUNT=
GCP_DEDICATED_PROJECTS_ENABLED=false
```

Fail closed: the GCP provider appears in discovery as disabled with a safe configuration reason until the enable flag and required shared-runtime values are present.

- [ ] **Step 2: Port the runtime contract and fake adapter first**

Copy the port’s narrow operations—ensure project, Artifact Registry, runtime service account, Cloud Run service, and GitHub WIF—into the GCP folder. Port `GcpRuntimeAdapterError` and the fake adapter. Write orchestrator tests against the fake before adding the real adapter.

- [ ] **Step 3: Port the real adapter with safe error translation**

Use `GoogleAuth` with cloud-platform scope and the sibling’s idempotent GET-or-create pattern. Every URL segment must be encoded. Translate Google API failures to `ProviderError`/`GcpRuntimeAdapterError` with safe messages; never log access tokens, credential JSON, secret values, or raw Google error bodies.

- [ ] **Step 4: Port idempotent metadata and provisioning jobs**

Use the existing Enterprise schemas created by `20260701_gcp_runtime_expand_contract.sql`: `runtime_deployments`, `runtime_domains`, `runtime_secrets`, `gcp_operations`, and `billing_lifecycle`. Do not edit that migration. The repository performs upserts/updates only; the orchestration service creates a job keyed by workspace, project, target, and environment before issuing provider calls.

- [ ] **Step 5: Implement the provider adapter and GCP workflow job**

`GcpDeploymentProvider` advertises `provider: 'gcp'`, `deploymentStrategy: 'gcp_cloud_run'`, managed-mode capabilities, GCP slot support, and a config schema requiring project id/region/Artifact Registry service metadata. `gcp.workflow.ts` emits a keyless GitHub Actions deployment job using Workload Identity Federation—never a downloaded service-account key.

- [ ] **Step 6: Mock-only verification**

Run:

```powershell
npm test -- --runInBand src/modules/deployments/providers/gcp
npm run typecheck
npm run lint
```

Expected: PASS with the fake adapter or mocked `GoogleAuth`/fetch. Do not set `GCP_DEPLOYMENTS_ENABLED=true`, run Terraform, or execute a live smoke test.

## Task 6: Convert the frontend to provider discovery and generic configuration

**Files:**

- Modify: `src/lib/api/contracts.ts`
- Modify: `src/lib/api/env-provisioning.ts`
- Modify: `src/lib/api/client.ts`
- Create: `src/lib/api/deployment-providers.ts`
- Create: `src/hooks/use-deployment-providers.ts`
- Modify: `src/hooks/use-provider-connections.ts`
- Modify: `src/hooks/use-deployment-provisioning-form.ts`
- Modify: `src/components/product/deployment-provisioning-setup.tsx`
- Modify: `src/components/product/project-env-panel.tsx`
- Modify: `src/components/product/project-detail-tabs.tsx`
- Modify: `src/components/product/workflow-builder.tsx`
- Modify: `src/styles/dashboard-projects.css`
- Modify: `tests/unit/api-client.test.ts`
- Modify: `tests/unit/env-provisioning-api.test.ts`
- Modify: `tests/unit/deployment-provisioning-setup.test.tsx`
- Modify: `tests/unit/env-provisioning-hooks.test.tsx`
- Modify: `tests/e2e/playwright-e2e.ts`

**Interfaces:**

```ts
export interface DeploymentProviderDescriptor {
  id: string;
  label: string;
  enabled: boolean;
  reason?: string;
  supportedSlots: string[];
  capabilities: ProviderCapabilities;
  configSchema: ProviderFormSchema;
  credentialSchema: ProviderFormSchema;
}

export function listDeploymentProviders(): Promise<{ providers: DeploymentProviderDescriptor[] }>;
```

- [ ] **Step 1: Add failing API and hook tests**

Mock a discovery response with Render, Vercel, and disabled GCP. Assert the hook exposes descriptors, does not select disabled GCP by default, and preserves a previously selected legacy provider when discovery is temporarily unavailable.

- [ ] **Step 2: Replace provider unions and hard-coded defaults at the API boundary**

Change `EnvProvider = 'render' | 'vercel'` and provider-specific request fields into `provider: string` plus `config: Record<string, unknown>`. Keep a compatibility mapper for existing UI state until the form migration is complete.

- [ ] **Step 3: Render provider choice and fields from discovery**

The setup form reads `supportedSlots`, `enabled`, `configSchema`, and `credentialSchema`. Render/Vercel-specific labels, initials, and fields become provider metadata/config-field rendering. GCP is visible when installed, selectable only when enabled, and explains missing configuration without exposing secrets.

- [ ] **Step 4: Preserve project page and env-var behavior**

Retain existing target cards, target actions, and env-var workflows. Switch their provider-specific URL/title helpers to descriptor-based helpers with safe fallbacks for old rows. Keep cached target rendering functional if discovery fails.

- [ ] **Step 5: Run frontend verification**

Run:

```powershell
npm test -- --runInBand tests/unit/api-client.test.ts tests/unit/env-provisioning-api.test.ts tests/unit/deployment-provisioning-setup.test.tsx tests/unit/env-provisioning-hooks.test.tsx
npm run lint
npm run typecheck
```

Expected: PASS. Browser/E2E fixtures use mocked discovery and mocked deployment APIs only.

## Task 7: Final verification, staged review, and PR handoff

**Files:**

- Modify: `docs/deployment-provisioning.md`
- Modify: `docs/deployment-provisioning-live-smoke.md`
- Modify: `.env.example`
- Modify: `docs/modular-architecture-deployments.md` only to mark accepted decisions and link this implementation plan; do not alter its original proposal history.

- [ ] **Step 1: Perform a source-boundary audit**

Run the provider-switch search from Task 4, `npm run boundaries`, and a review of changed imports. Confirm no core file imports a provider file, no provider imports another provider, and no frontend production path hard-codes Render/Vercel selection.

- [ ] **Step 2: Run the complete local verification set**

Run, in each repository:

```powershell
# backend
npm test -- --runInBand
npm run lint
npm run typecheck
npm run boundaries

# frontend
npm test -- --runInBand
npm run lint
npm run typecheck
```

Expected: all commands pass locally without a live provider call. If a suite requires unavailable external services, record the exact blocker and do not substitute a live environment.

- [ ] **Step 3: Review migration and security safety**

Verify every migration has a matching rollback, all provider credential code is write-only/log-redacted, GCP uses ADC/WIF rather than a stored service-account key by default, and feature flags are disabled by default.

- [ ] **Step 4: Prepare, but do not perform, handoff actions**

Leave changes uncommitted and unstaged unless the user explicitly asks otherwise. Report the planned branch name, changed files, test outputs, and proposed PR title:

```text
feat(deployments): add provider core and GCP Cloud Run adapter
```

Only after explicit user approval: create the `codex/` implementation branch, commit reviewable PR slices, push, and open a PR targeting `main`.

## Plan self-review

- Core/provider ownership, data migration, legacy compatibility, GCP implementation, frontend discovery, tests, security, and PR sequencing each have a task.
- The plan deliberately excludes live GCP testing, Terraform apply, credential entry, migration application, pushes, commits, and merges.
- Render/Vercel behavior is migrated under owner review; GCP is the only newly implemented provider.
