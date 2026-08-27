# Deployment Provider Plugin Architecture

**Status:** Proposed target design; current implementation mapping is included below
**Scope:** The deployment-provider subsystem only, targeting the backend exactly as it
exists on `main` today — one NestJS application, one deployable, the module layout under
`src/modules/`. Every file path, line reference and migration in this document is written
against that codebase.

> **Current implementation alignment (2026-08-27):** the repository has since
> consolidated the subsystem under `src/modules/runtime/`. The generic
> `DeploymentProviderRegistry`, `ProviderClientRegistry`,
> `WorkflowFragmentRegistry`, and `ProviderCiSecretsInstallerRegistry` are now
> open-id map registries, and the staged workflow builder composes provider
> fragments without Render/Vercel branches. The provider-plugin acceptance test
> exercises a fake provider through metadata, client, workflow, and CI seams.
> Render/Vercel compatibility fields, target strategy mapping, and the parallel
> GCP runtime remain intentionally inside Runtime so the existing HTTP and
> database contracts do not change. The stronger promise in this document —
> that a production provider is completely zero-edit outside its folder — is a
> future target, not a claim about this refactor.

> **Current seam status:** provider metadata adapters are split into the
> provider folders; slot policy is descriptor-driven and fails closed; workflow
> target expansion and provider workflow fragments are selected through the
> generic `WorkflowFragmentRegistry`; and CI secret installation is registry
> driven. Token/scope/storage/legacy strategy and DTO compatibility remain
> Runtime-owned compatibility code. The full conformance suite below remains a
> future hardening target; the current acceptance test covers the generic
> metadata, client, workflow, and CI contribution seams.


**Standalone:** This document is self-contained. It introduces no dependency on any other
proposed change to this repository, and nothing in it needs to wait on one. It can be
read, reviewed, approved and implemented entirely on its own.
**Purpose:** Let two developers build deployment integrations (Render/Vercel, GCP, future
providers) fully in parallel, in separate folders, with interchangeable API endpoints and
no shared-file merge conflicts.

---

## 1. Problem (historical baseline before current remediation)

Before the current remediation, the codebase was provider-*aware* but not
provider-*pluggable*. A real plugin seam
already exists (`RuntimeEnvProviderClient` in
`src/modules/env-provisioning/provider-clients/runtime-env-provider.client.ts`), but
provider identity leaks through ~19 non-test files. Adding a third provider means both
devs editing the same files every day.

### Leak inventory

| # | Leak | Location |
|---|------|----------|
| 1 | `EnvProvider = 'render' \| 'vercel'` union | `env-provisioning/env-provisioning.types.ts:1` |
| 2 | Provider fields hoisted onto shared types (`renderServiceType`, `vercelTeamId`, `dockerfilePath`, …) | `env-provisioning.types.ts`, `provider-clients/runtime-env-provider.client.ts` |
| 3 | `if (provider === 'render')` registry | `provider-clients/provider-client.registry.ts` |
| 4 | Strategy `if/else` chain | `deployment-strategy.resolver.ts` |
| 5 | Deploy job YAML emitted inline (`vercelDeployJob`, `renderDeployJob`) | `workflows/staged-workflow.builder.ts:708-890` |
| 6 | `secretNames` shape enumerates provider-specific keys | `workflows/dto/generate-workflow.dto.ts` |
| 7 | CI-secret install branches on provider/strategy | `project-deployment-provisioning.service.ts:137-181` |
| 8 | Public URL / dashboard URL / slot / environment resolution | `deployment-targets.service.ts:89-99, 670-676, 800-812` |
| 9 | Token selection per provider | `env-vars.service.ts:403` |
| 10 | `const PROVIDERS: EnvProvider[] = ['render','vercel']` | `provider-connections.service.ts:16` |
| 11 | Quota counting with provider literals in raw SQL | `usage/usage-quota.service.ts:115-218` |
| 12 | Provider branching in project setup | `projects/projects.service.ts:127, 2287-2832` |
| 13 | `@IsIn(['render','vercel'])` | `projects/dto/create-project.dto.ts:48, 150` |
| 14 | `providers: ['render','vercel']` | `capabilities/capabilities.controller.ts:19` |
| 15 | `CHECK (provider IN (...))` on 3 tables + per-provider columns | `supabase/migrations/20260608_env_provisioning.sql:9,27,51` |

Items 1, 5, 11, 12 and 15 are the highest-conflict surfaces.

---

## 2. Decisions

| Decision | Choice |
|---|---|
| **API shape** | Generic route (`provider` is data) **+** optional provider-specific extra routes |
| **Migration** | Extract core first as a behavior-preserving refactor, then both devs build in parallel |
| **Data model** | Single `provider_config JSONB` column; sidecar table only when a provider justifies it |
| **Frontend** | In scope — ship `GET /deployment-providers` discovery so the FE renders from data |

---

## 3. Target structure

```
src/modules/deployments/
  core/                                  # shared — change-by-agreement
    deployment-provider.contract.ts
    deployment-provider.registry.ts
    deployment-provider.tokens.ts
    deployment-config.types.ts
    dto/
      create-deployment-target.dto.ts    # generic: { provider, slot, ownershipMode, config }
    deployments.controller.ts            # generic CRUD/status/logs
    deployment-providers.controller.ts   # GET /deployment-providers (discovery)
    deployments.service.ts
    testing/
      provider-contract.suite.ts         # shared conformance tests
  providers/
    render/            # OWNER: Lloyd
      render.provider.ts
      render.client.ts
      render.config.ts
      render-ci-secrets.service.ts
      render.workflow.ts
      render.controller.ts               # optional provider-specific routes
      render.module.ts
      index.ts
    vercel/            # OWNER: Lloyd
    gcp/               # OWNER: Anton
      gcp.provider.ts
      gcp.client.ts
      gcp.config.ts
      gcp-ci-secrets.service.ts
      gcp.workflow.ts
      gcp.controller.ts
      gcp.module.ts
      index.ts
```

Rule: **a provider folder may import from `core/`, never from another provider folder,
and `core/` must never import from `providers/`.** Enforce with an ESLint
`no-restricted-imports` rule so the boundary is checked in CI, not by review discipline.

---

## 4. The contract

```ts
// core/deployment-provider.contract.ts

export interface ProviderCapabilities {
  logs: boolean;
  deployHistory: boolean;
  envVars: boolean;
  teardown: boolean;
  managedMode: boolean;     // can the platform own the account, or BYO only?
  liveStatus: boolean;

  /**
   * Can `core` reach this provider's control plane over the network? Render,
   * Vercel and GCP are public APIs the platform calls directly. A target that
   * is only reachable from inside a customer's network is not — the deploy is
   * executed there by their own pipeline runner and reported back through the
   * existing `POST /ci/report` channel, which makes status eventually
   * consistent rather than live. Declaring this now is what keeps adding such
   * a provider later from being a breaking change to `core`. See §12.
   */
  connectivity: 'direct' | 'indirect';

  /** Can we enumerate what already exists in the account? Not always possible. */
  enumerable: boolean;

  /** Whether the platform holds the deploy credential, or something outside it does. */
  credentialCustody: 'platform' | 'external';
}

/**
 * Status is never assumed live. `observedAt` + `source` let a caller tell
 * "confirmed running just now" from "last seen running four minutes ago",
 * which is the difference between a provider `core` can query directly and one
 * whose state only arrives when a pipeline reports in. The existing SSE logs
 * endpoint already returns a `source` discriminator,
 * so this follows a precedent rather than inventing one.
 */
export interface ProviderTargetStatus {
  exists: boolean;
  state?: string;
  url?: string | null;
  observedAt: string;                  // ISO timestamp
  source: 'live' | 'cached';
  metadata?: Record<string, unknown>;
}

/**
 * Opaque credential blob. Render and Vercel put a single API token in here;
 * GCP puts a service-account key or Workload Identity Federation config.
 * `core` encrypts, stores and hands it back untouched — it never inspects the
 * shape. See §7 for why the current single-token column cannot stay.
 */
export type ProviderCredential = Record<string, unknown>;

/** Normalized failure. Providers translate their own errors into these. */
export type ProviderErrorKind =
  | 'unauthorized'      // credential rejected      → 401
  | 'forbidden'         // valid credential, no access to that resource → 403
  | 'not_found'         // target gone on the provider side → 404
  | 'quota_exceeded'    // provider-side plan/quota limit → 402
  | 'invalid_config'    // providerConfig rejected  → 400
  | 'not_supported'     // capability this provider does not have → 501
  | 'upstream_failure'; // provider API down/5xx    → 502

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryable = false,
  ) { super(message); }
}

export interface DeploymentTargetRecord {
  id: string;
  projectId: string;
  provider: string;
  slot: 'backend' | 'frontend' | 'standalone';
  ownershipMode: 'byo' | 'flowci_managed';
  providerConnectionId: string | null;
  providerProjectId: string;
  providerProjectName: string;
  repoFullName: string;
  branchName: string;
  deploymentStrategy: string;                // provider-namespaced, e.g. 'gcp_cloud_run_image'
  providerConfig: Record<string, unknown>;   // validated by the owning provider only
  providerMetadata: Record<string, unknown>; // discovered at runtime
  // 'provisioning' is new: it makes creation async-shaped for every provider,
  // so a provider that cannot create synchronously does not force a breaking
  // change on the shared POST endpoint later. See §12.
  status: 'provisioning' | 'active' | 'missing' | 'failed';
}

export interface DeploymentProvider {
  readonly id: string;                 // 'render' | 'vercel' | 'gcp'
  readonly label: string;              // 'Google Cloud Platform'
  readonly capabilities: ProviderCapabilities;

  /**
   * Which slots this provider may occupy. Replaces the hardcoded
   * `assertProviderSlotAllowed` in `deployment-targets.service.ts:665-680`
   * (Render → backend-only, Vercel → frontend-only). Also what the discovery
   * endpoint advertises, so the frontend can grey out invalid combinations
   * instead of round-tripping to find out.
   */
  readonly supportedSlots: ReadonlyArray<'backend' | 'frontend' | 'standalone'>;
  defaultSlot(): 'backend' | 'frontend' | 'standalone';

  /** JSON Schemas — served by GET /deployment-providers, and what the FE renders forms from. */
  readonly configSchema: JSONSchema;
  readonly credentialSchema: JSONSchema;

  /** Validate + normalize the opaque config blob. Throws BadRequest on bad input. */
  validateConfig(raw: unknown, ctx: ValidateContext): Record<string, unknown>;

  /**
   * Short non-secret display hint for a stored credential — replaces
   * `token_last_four`, which is meaningless for a JSON key. Render/Vercel
   * return the token's last 4; GCP returns the service-account email.
   */
  credentialHint(credential: ProviderCredential): string;

  /** Which deploymentStrategy this target resolves to. Replaces the shared resolver. */
  resolveStrategy(input: ResolveStrategyInput): string;

  // --- lifecycle ---
  validateConnection(credential: ProviderCredential): Promise<ProviderAccountSummary>;
  listTargets(credential: ProviderCredential): Promise<ProviderDeploymentTarget[]>;
  createTarget(input: CreateTargetInput): Promise<ProviderDeploymentTarget>;
  getTargetStatus(input: TargetRefInput): Promise<ProviderTargetStatus>;
  deleteTarget(input: TargetRefInput): Promise<{ deleted: boolean }>;

  // --- env vars ---
  upsertEnvironmentVariables(input: UpsertEnvInput): Promise<ProviderProvisionResult>;
  deleteEnvironmentVariable(input: DeleteEnvInput): Promise<{ key: string; status: 'removed' }>;

  // --- presentation (replaces the URL if/else chains) ---
  resolvePublicUrl(target: DeploymentTargetRecord, env: EnvEnvironment): string | null;
  resolveDashboardUrl(target: DeploymentTargetRecord): string | null;
  environmentsFor(target: DeploymentTargetRecord): EnvEnvironment[];

  // --- CI/CD ---
  /** Returns the GitHub Actions job object for this target, or null if none needed. */
  buildDeployJob(target: DeploymentTargetRecord, ctx: WorkflowContext): WorkflowJob | null;
  installCiSecrets?(input: InstallCiSecretsInput): Promise<{ githubSecrets: Record<string, string> }>;

  // --- quota (replaces raw SQL provider literals) ---
  readonly managedQuotaKey?: string;   // e.g. 'managed_gcp_services'

  // --- optional, gated by `capabilities` ---
  getLogs?(input: LogsInput): Promise<ProviderLogEntry[]>;
  getDeployHistory?(input: TargetRefInput): Promise<ProviderDeployEvent[]>;
}
```

Four rules that keep this stable:

1. **Capabilities are declared, never inferred.** `core` checks `capabilities.logs`
   before calling `getLogs`, and returns a uniform `501`/graceful-degradation response
   otherwise. Callers never feature-detect with `typeof p.getLogs === 'function'`.
2. **Provider-specific data only ever travels inside `providerConfig` /
   `providerMetadata` / `ProviderCredential`.** No new top-level field is added to
   `DeploymentTargetRecord` for one provider's benefit.
3. **Providers throw `ProviderError`, never raw HTTP exceptions.** A provider that
   throws `BadRequestException` directly has hardcoded an HTTP mapping that `core`
   owns. One translation layer in `core` means every provider fails identically from
   the frontend's point of view — which is most of what "interchangeable" means in
   practice.
4. **`core` never inspects a credential.** It encrypts, stores, decrypts and passes
   it through. Only the owning provider knows whether it holds a bearer token, a
   service-account key, or a federation config.

---

## 5. Registry — no `if/else`, ever again

```ts
// core/deployment-provider.tokens.ts
export const DEPLOYMENT_PROVIDER = Symbol('DEPLOYMENT_PROVIDER');

// core/deployment-provider.registry.ts
@Injectable()
export class DeploymentProviderRegistry {
  private readonly byId: Map<string, DeploymentProvider>;

  constructor(@Inject(DEPLOYMENT_PROVIDER) providers: DeploymentProvider[]) {
    this.byId = new Map(providers.map((p) => [p.id, p]));
  }

  get(id: string): DeploymentProvider {
    const provider = this.byId.get(id);
    if (!provider) throw new BadRequestException(`Unknown deployment provider: ${id}`);
    return provider;
  }

  has(id: string): boolean { return this.byId.has(id); }
  list(): DeploymentProvider[] { return [...this.byId.values()]; }
}
```

Registering a whole new provider is **one module file**:

```ts
// providers/gcp/gcp.module.ts
@Module({
  imports: [DeploymentsCoreModule, GithubModule],
  controllers: [GcpController],              // optional provider-specific routes
  providers: [
    GcpClient,
    GcpCiSecretsService,
    { provide: DEPLOYMENT_PROVIDER, useClass: GcpDeploymentProvider, multi: true },
  ],
})
export class GcpDeploymentModule {}
```

…plus one line in the app module's imports. **Nothing else in the repo changes.**

Feature-gating for dark merges:

```ts
// app.module.ts
...enabledProviderModules(process.env.DEPLOY_PROVIDERS_ENABLED ?? 'render,vercel')
```

An unfinished GCP provider merges to `main` behind `DEPLOY_PROVIDERS_ENABLED` without
being reachable, so neither dev sits on a long-lived branch.

---

## 6. API surface

**The public route surface does not change.** Every path below except the discovery
endpoint already exists today, on `deployment-targets.controller.ts`,
`provider-connections.controller.ts` and `env-vars.controller.ts`. This is a refactor
*behind* the existing URLs, not a new API: no frontend change is required for anything
to keep working, and the FE can adopt discovery on its own schedule. It also means the
existing e2e tests are the regression net for the whole extraction.

**`POST` is async-shaped for every provider.** It returns the target record with
`status: 'provisioning'` and does not promise the resource is live on return; clients
confirm via `GET .../actions` or `POST .../sync`, which they already do. Render and
Vercel can in practice create synchronously and may return `'active'` immediately — the
point is that the *contract* never guarantees it, so a provider that genuinely cannot
(anything the platform cannot reach directly) slots in without changing this endpoint's
semantics. Getting
this wrong is not a small cost: fixing it later is a breaking change landing in `core/`,
the one directory both devs share.

Three guards currently protect these routes — `SessionAuthGuard`, `SubscriptionGuard`
and `EnvFeatureGuard`. **All three carry over unchanged.** Rebuilding a controller
without them silently opens a paid, feature-flagged surface, so this is explicitly on
the checklist in §9 rather than left to memory.

### Generic (canonical) — adding a provider adds zero routes

```
GET    /deployment-providers                              # discovery — the only new route
GET    /projects/:projectId/deployment-targets
POST   /projects/:projectId/deployment-targets            # { provider, slot, ownershipMode, config }
PATCH  /projects/:projectId/deployment-targets/:targetId
DELETE /projects/:projectId/deployment-targets/:targetId
POST   /projects/:projectId/deployment-targets/:targetId/sync
GET    /projects/:projectId/deployment-targets/:targetId/logs
GET    /projects/:projectId/deployment-targets/:targetId/logs/stream   # SSE
GET    /projects/:projectId/deployment-targets/:targetId/actions

# credentials — provider-agnostic once ProviderCredential lands (§7)
GET    /provider-connections
POST   /provider-connections                              # { provider, label, credential }
DELETE /provider-connections/:id

# env vars — already provider-agnostic apart from token selection
GET    /projects/:projectId/env-vars
POST   /projects/:projectId/env-vars/provision
POST   /projects/:projectId/env-vars/validate
DELETE /projects/:projectId/env-vars/:metadataId
```

`POST /provider-connections` is the one payload that changes shape: `token: string`
becomes `credential: object`, validated against the provider's `credentialSchema`.
Accept the old `token` field as a deprecated alias mapping to `{ token }` so the
frontend is not forced to ship in lockstep.

Swapping provider = changing one field value:

```jsonc
// Render target
{ "provider": "render", "slot": "backend",
  "config": { "serviceType": "web_service", "region": "singapore", "runtime": "docker" } }

// GCP target — same endpoint, same client code
{ "provider": "gcp", "slot": "backend",
  "config": { "projectId": "acme-prod", "region": "asia-southeast1", "service": "cloud_run" } }
```

### Provider-specific extras — owned entirely by one dev

```
GET /deployment-providers/gcp/regions
GET /deployment-providers/gcp/artifact-registries
GET /deployment-providers/render/instance-types
```

These live in `providers/<id>/<id>.controller.ts`. Because the route prefix is namespaced
by provider id, two devs can never collide on a route.

### Discovery response (drives the frontend)

```jsonc
GET /deployment-providers
{
  "providers": [
    { "id": "render", "label": "Render", "enabled": true,
      "capabilities": { "logs": true, "deployHistory": true, "envVars": true,
                        "teardown": true, "managedMode": true, "liveStatus": true,
                        "connectivity": "direct", "enumerable": true,
                        "credentialCustody": "platform" },
      "slots": ["backend"],
      "configSchema":     { "type": "object", "properties": { /* ... */ } },
      "credentialSchema": { "type": "object", "properties": { /* ... */ } } },
    { "id": "gcp", "label": "Google Cloud Platform", "enabled": true /* ... */ }
  ]
}
```

The frontend renders the provider picker from `slots` + `capabilities`, and both the
config and credential forms from their schemas, so a new provider needs **no frontend
release**. `connectivity` and `credentialCustody` are what let it pick the right
onboarding flow — "paste a credential" for a provider the platform calls directly versus
"point us at your pipeline runner" for one it cannot reach — without the FE knowing which
providers exist. This is the piece that makes it plug-and-play
end to end rather than only inside the backend.

---

## 7. Data model

Replace the per-provider column sprawl with one blob. New migration, e.g.
`supabase/migrations/2026XXXX_deployment_provider_plugin.sql`:

All three tables live in the `env_provisioning` schema and must be schema-qualified:

```sql
ALTER TABLE env_provisioning.project_deployment_targets
  ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- backfill existing render columns into the blob
UPDATE env_provisioning.project_deployment_targets
SET provider_config = provider_config
  || jsonb_strip_nulls(jsonb_build_object(
       'serviceType',     render_service_type,
       'runtime',         render_runtime,
       'instanceType',    render_instance_type,
       'region',          render_region,
       'environmentName', render_environment_name,
       'dockerContext',   docker_context,
       'dockerfilePath',  dockerfile_path,
       'imageUrl',        image_url))
WHERE provider = 'render';

-- drop the closed provider enum; keep referential integrity via a registry table
CREATE TABLE IF NOT EXISTS env_provisioning.deployment_providers (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT INTO env_provisioning.deployment_providers (id, label)
VALUES ('render', 'Render'), ('vercel', 'Vercel')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_provider_check,
  ADD CONSTRAINT project_deployment_targets_provider_fk
    FOREIGN KEY (provider) REFERENCES env_provisioning.deployment_providers(id);

-- `provisioning` is not in the existing status CHECK
-- (20260608_env_provisioning.sql:37) and must be added explicitly
ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_status_check,
  ADD CONSTRAINT project_deployment_targets_status_check
    CHECK (status IN ('provisioning', 'active', 'missing', 'failed'));
```

The same constraint swap is needed on the other two tables carrying the provider check —
`env_provisioning.provider_connections` and `env_provisioning.project_env_var_metadata`
(see `supabase/migrations/20260608_env_provisioning.sql:9,51`).

### Credentials

`provider_connections` currently stores `encrypted_token TEXT NOT NULL` plus
`token_last_four TEXT NOT NULL`. Both assume the credential is one short opaque string.
That holds for Render and Vercel and breaks immediately for GCP, whose credential is a
service-account JSON key or a Workload Identity Federation config — `slice(-4)` of a JSON
blob is not a useful display hint. Widen it once, in the core extraction:

```sql
ALTER TABLE env_provisioning.provider_connections
  ADD COLUMN IF NOT EXISTS encrypted_credential TEXT,
  ADD COLUMN IF NOT EXISTS credential_hint      TEXT;

UPDATE env_provisioning.provider_connections
SET encrypted_credential = encrypted_token,   -- re-encrypted as {"token": "..."} in code
    credential_hint      = token_last_four
WHERE encrypted_credential IS NULL;
```

The backfill is a **code-side re-encryption**, not a pure SQL copy: the stored ciphertext
decrypts to a bare string and must be re-encrypted as `{"token": "..."}` so the blob shape
is uniform. Write it as a one-shot script alongside the migration, keep the legacy columns
until it has run in every environment, and drop them in the same cleanup that removes the
`render_*` columns.

Each new provider then ships **its own** migration containing only its registry row:

```sql
INSERT INTO env_provisioning.deployment_providers (id, label)
VALUES ('gcp', 'Google Cloud Platform')
ON CONFLICT (id) DO NOTHING;
```

Migration rules during the parallel window:

- Only ever **create new timestamped files**. Never edit an existing migration.
- The legacy `render_*` columns stay in place (unused) until both providers are on the
  blob; drop them in a separate cleanup migration afterwards.
- A provider that genuinely needs SQL-level querying or constraints may add a sidecar
  table (`gcp_target_settings`) in its own migration — but must justify it in review,
  since it costs a join in the repository layer.

---

## 8. Workflow builder inversion (target design; current slice noted above)

This was the highest-value leak in the historical baseline. The current builder
composes provider fragments; the target design below remains the stronger
zero-edit extension model. Previously, `staged-workflow.builder.ts:708-890` hardcoded
`vercelDeployJob` and `renderDeployJob` inside a 1090-line file both devs would edit.

**After:**

```ts
// workflows/staged-workflow.builder.ts
function buildPackageDeploymentPlan(targets, ctx, registry: DeploymentProviderRegistry) {
  const jobs: Record<string, WorkflowJob> = {};
  for (const target of targets) {
    const job = registry.get(target.provider).buildDeployJob(target, ctx);
    if (job) jobs[deploymentJobId(target.provider, target.slot, target.branchName)] = job;
  }
  return { jobs, jobIds: Object.keys(jobs), promotionNeeds: derivePromotionNeeds(jobs) };
}
```

Render's YAML lives in `providers/render/render.workflow.ts`; GCP's in
`providers/gcp/gcp.workflow.ts`. The builder becomes provider-agnostic and stops being a
conflict magnet.

Related cleanup: `secretNames` in `workflows/dto/generate-workflow.dto.ts` becomes
`Record<string, string>` instead of an enumerated per-provider key list, and
`deploymentTargets[].provider` loses its `'vercel' | 'render'` union.

The central reusable-workflow repo (`cicd-external-project/cicd-workflow`) follows the
same split: `render-deploy.yml`, `vercel-deploy.yml`, `gcp-deploy.yml` are separate files
pinned by `CENTRAL_WORKFLOW_REF`, so the two devs don't collide there either.

---

## 9. The core extraction — do this first

**One PR, behavior-preserving, no new features.** This is the one piece of ordering the
plan depends on: it lands before either provider's feature work starts. Both devs are
blocked on it, so keep it tight and merge it fast. Everything after it — the GCP provider,
Render/Vercel work, and the frontend consuming `GET /deployment-providers` — runs
concurrently with zero shared files.

Scope checklist:

- [ ] Create `deployments/core/` with contract, tokens, registry, generic DTO, service,
      controller, discovery controller, conformance suite.
- [ ] Move `RenderEnvClient` → `providers/render/`, implement `DeploymentProvider`
      by wrapping the existing client (adapter, not rewrite).
- [ ] Same for Vercel.
- [ ] Move `render-ci-secrets.service.ts` / `vercel-ci-secrets.service.ts` into their
      provider folders behind `installCiSecrets`.
- [ ] Move `renderDeployJob` / `vercelDeployJob` into `<provider>.workflow.ts`; invert
      `buildPackageDeploymentPlan` to loop over the registry.
- [ ] Fold `DeploymentStrategyResolver` into each provider's `resolveStrategy`.
- [ ] Replace URL/slot/environment `if/else` in `deployment-targets.service.ts` and
      `project-deployment-provisioning.service.ts` with contract calls.
- [ ] Replace `assertProviderSlotAllowed` (`deployment-targets.service.ts:665-680`) with
      a `supportedSlots` check in `core`.
- [ ] Add the `ProviderError` → HTTP translation layer in `core`; convert the Render and
      Vercel clients' thrown exceptions to `ProviderError`.
- [ ] Widen credentials: `encrypted_credential` / `credential_hint` columns, the
      re-encryption backfill script, `POST /provider-connections` accepting
      `credential` with `token` as a deprecated alias, and `validateTeamAccess`
      (Vercel-only today) folded behind the provider.
- [ ] **Carry over `SessionAuthGuard`, `SubscriptionGuard` and `EnvFeatureGuard`** onto
      every rebuilt controller. Assert it in a controller-level spec so a future
      refactor cannot silently drop them.
- [ ] Replace `env-vars.service.ts:403` token selection with a registry lookup.
- [ ] Replace `provider-connections.service.ts:16` `PROVIDERS` const with `registry.list()`.
- [ ] Replace `capabilities.controller.ts:19` literal with `registry.list().map(p => p.id)`.
- [ ] Parameterize `usage-quota.service.ts` raw SQL on `managedQuotaKey` instead of
      provider literals.
- [ ] `create-project.dto.ts` — swap `@IsIn(['render','vercel'])` for a registry-backed
      validator.
- [ ] `projects.service.ts` — route the provider branches at :127, :2287-2832 through the
      contract (largest single chunk; consider splitting into its own follow-up PR if it
      threatens to hold up the merge).
- [ ] Migration: `provider_config` blob + backfill + `deployment_providers` table + FK swap
      + `provisioning` added to the status CHECK.
- [ ] Add ESLint `no-restricted-imports` boundary rule.
- [ ] Add `.github/CODEOWNERS`.

**Definition of done:** the full existing spec suite passes unchanged. Any spec that has
to change is a signal of behavior drift — investigate rather than update the test.

---

## 10. Parallel-work protocol

### CODEOWNERS

Handles below are placeholders — substitute real GitHub usernames before committing.

```
# .github/CODEOWNERS
/src/modules/deployments/core/             @gcp-owner @render-owner   # both must approve
/src/modules/deployments/providers/gcp/    @gcp-owner
/src/modules/deployments/providers/render/ @render-owner
/src/modules/deployments/providers/vercel/ @render-owner
/supabase/migrations/                      @gcp-owner @render-owner
```

### Rules for the parallel window

1. **`core/` is change-by-agreement.** Any contract change ships as its own small PR,
   reviewed by both devs, merged before dependent work.
2. **Contract changes are additive-only.** New optional methods, new capability flags —
   never a rename or a signature change. Renames get batched into a coordinated cleanup
   after both features land.
3. **Never edit another dev's provider folder.** Need a change there? Open an issue or
   ask; don't reach in.
4. **Never edit an existing migration.** New timestamped file, always.
5. **Merge to `main` early and often behind `DEPLOY_PROVIDERS_ENABLED`.** No long-lived
   feature branches — that's what reintroduces the conflicts this design removes.
6. **Rebase on `main` daily.** With correct ownership boundaries this should be a no-op;
   if it isn't, a boundary was violated and it's worth finding out why immediately.

---

## 11. Conformance suite

Interchangeability is a claim that decays unless it's tested. `core/testing/` exports a
suite every provider runs against its own implementation:

```ts
// providers/gcp/gcp.provider.spec.ts
import { runProviderContractSuite } from '../../core/testing/provider-contract.suite';

runProviderContractSuite({
  name: 'gcp',
  build: () => new GcpDeploymentProvider(fakeGcpClient(), fakeConfig()),
  sampleConfig: { projectId: 'demo', region: 'asia-southeast1', service: 'cloud_run' },
  sampleCredential: { serviceAccountKey: '{"type":"service_account", ...}' },
});
```

The suite asserts the invariants `core` relies on:

- `id` is non-empty, lowercase, matches the DI registration
- `validateConfig` rejects unknown/missing keys and returns a normalized object
- `configSchema` validates `sampleConfig`
- every capability flagged `true` has its corresponding method implemented
- every capability flagged `false` either omits the method or has it throw
  `ProviderError('not_supported')` — never returns empty data that reads as "no logs"
  when the truth is "logs unsupported"
- `resolveStrategy` returns a provider-namespaced string (`gcp_*`, `render_*`)
- `buildDeployJob` output parses as valid GitHub Actions YAML
- `resolvePublicUrl` / `resolveDashboardUrl` return `null` rather than throwing on
  incomplete metadata
- `defaultSlot()` is a member of `supportedSlots`
- `getTargetStatus` always populates `observedAt` and `source`; a provider declaring
  `liveStatus: false` never returns `source: 'live'`
- `capabilities.enumerable: false` implies `listTargets` throws `not_supported` rather
  than returning `[]`
- `credentialSchema` validates `sampleCredential`, and `credentialHint` returns a
  non-empty string that does **not** contain the secret
- failures surface as `ProviderError` with a valid `kind` — never a raw HTTP exception,
  never a bare `Error`

A provider that passes this suite is guaranteed drop-in.

---

## 12. Designed for extension

Providers not yet in scope are out of scope — but three assumptions in a naive version of
this contract would have made adding them a breaking change to `core/`, which is the one
directory both devs share. Those three are relaxed up front; nothing else here is built
speculatively.

| Assumption | Why it fails eventually | Relaxed by |
|---|---|---|
| The platform can reach the provider over the public internet | A target inside a customer network is unreachable from here; the deploy is executed by a pipeline runner in that network instead | `capabilities.connectivity` |
| Creation is synchronous — the resource exists when `POST` returns | When a pipeline performs the deploy, creation completes on its run, not in the request | `status: 'provisioning'` + async-shaped `POST` (§6) |
| A status read is live | State that arrives via `POST /ci/report` is a point-in-time read, and "running 4 minutes ago" is not "running now" | `ProviderTargetStatus.observedAt` + `source` |

The mechanism for the indirect case is not new infrastructure: the platform already
generates the pipeline, and `POST /ci/validate` + `POST /ci/report` (`src/modules/ci/`)
already accept authenticated results from it using project-scoped `aci_` tokens. A
provider that cannot be reached directly emits a deploy job pinned to the customer's own
runner and reports back through that existing channel.

The deliberate omission: there is **no operation/job resource** (`POST` → `202` +
`GET /operations/:id`). That is the full async treatment and it is real complexity Render
and Vercel do not need. The `provisioning` status is enough to make adding it later a
non-breaking change, which is the only property worth paying for now.

### Adjacent axes this pattern does not cover

Worth naming so nobody assumes deployment providers were the whole modularity problem.
These are all currently single-implementation, and the first is both larger and
underneath this one — `buildDeployJob` emits GitHub Actions YAML, so a customer on a
different forge breaks every provider at once.

| Axis | Today | Rough size |
|---|---|---|
| SCM / CI | GitHub Actions; `CENTRAL_WORKFLOW_REF`, `github.service.ts` (3,383 LOC, 43 call sites from `projects.service.ts`) | Larger than this work |
| Container registry | GHCR | Moderate |
| Secrets backend | GitHub Actions secrets | Moderate |
| Identity | Supabase sessions, `SessionAuthGuard` | Large |
| Notifications | email / Slack | Small |

None of these are in scope. The only ask is that `staged-workflow.builder.ts` stops
accumulating new responsibility, since it is the seam that would have to split first.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| The core extraction is large and touches `projects.service.ts` (4,545 lines) | Split the `projects.service.ts` portion into a follow-up PR if it delays the merge; core + registry + workflow inversion is the part that actually unblocks parallel work |
| Credential re-encryption backfill touches live secrets — a bad run locks every customer out of their provider connections | Additive columns only, legacy `encrypted_token` left intact until the new path is proven; script is idempotent and re-runnable; verify by decrypting a sample in each environment before dropping anything |
| JSONB loses SQL-level typing on provider config | Contract-level `validateConfig` + `configSchema` is the enforcement point; sidecar table available where SQL constraints genuinely matter |
| Provider-specific behavior leaking back into `core/` over time | ESLint import boundary + CODEOWNERS dual review on `core/` |
| Frontend has its own hardcoded provider enum | The discovery endpoint is in the core extraction precisely so the FE can delete its enum as soon as that lands |
| GCP has no single "deploy hook URL" analogue like Render | GCP job authenticates via Workload Identity Federation and deploys from the pipeline; `installCiSecrets` installs WIF provider + service-account secrets. Confirm before GCP work starts |
