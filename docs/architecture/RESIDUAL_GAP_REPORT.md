# Residual Gap Report

**Date:** 2026-08-25
**Branch:** codex/modular-monolith-boundaries (merged to codex/modular-monolith-trunk via PR #9)
**Method:** fresh line-by-line re-audit of every plan task against the actual source tree, dependency-cruiser config, test suite, and git history.

## Verification re-confirmed

`npm run boundaries` and `npm run boundaries:new` both pass with 0 violations
(281 modules, 1,129 dependencies). The baseline file is genuinely `[]`.

---

## Gaps, ranked by impact

### 1. ProjectsService was never actually decomposed (Task 9)

The plan''s Task 9 says: "Move the existing methods and dependencies verbatim"
into focused application services, with ProjectsService as a "compatibility
facade." What actually happened is the reverse: the six new services in
projects/application/ are mostly thin pass-through wrappers that delegate INTO
the still-monolithic ProjectsService.

- projects.service.ts remains **4,194 lines** (was ~4,548).
- project-lifecycle.service.ts (59 lines): every method calls straight into
  `this.projectsService.createProject()/setupProject()/disconnectProject()/syncProjects()`.
- project-dashboard.service.ts (45 lines): same pattern -- pure delegation.
- project-workflows.service.ts (43 lines): same pattern.
- project-previews.service.ts: **real independent logic** (fetches deployment
  history via the DEPLOYMENT_HISTORY_QUERY facade and computes branch previews).
- project-drift-repair.service.ts: **real independent logic** (owns drift
  repair actions end-to-end).
- project-provisioning.service.ts: real but narrow (creates hierarchy-managed
  projects directly via ProjectsRepository).

The controller uses optional-chaining with fallback:
```
this.projectDashboardService?.getProjectOverview(id, userId) ??
  this.projectsService.getProjectOverview(id, userId)
```
...so the new services are preferred when wired, but ProjectsService is still
called directly for at least 15 routes. No logic was moved out of
ProjectsService itself.

**Impact:** the review''s own "primary hotspot" concern is unresolved. This is
the largest remaining architectural debt.

### 2. Task 6 Step 3''s layer-enforcement rules were never added to .dependency-cruiser.cjs

The plan explicitly says:

> Extend .dependency-cruiser.cjs with rules that reject: domain files importing
> @nestjs, pg, @supabase, api, or infrastructure; api files importing an
> infrastructure repository or provider adapter; and one provider adapter
> importing another provider adapter.

None of these rules exist. The config has only the original five global rules.
This means intra-deployments layer violations would not be caught by `npm run
boundaries` today.

Two concrete leaks already visible (not caught because no rule exists):

- `deployments/deployment-targets.controller.ts` imports a type directly from
  `./deployment-targets.repository` (api -> infra leak).
- `deployments/application/project-deployments.service.ts` imports
  `ProviderClientRegistry` and `EnvTokenEncryptionService` from module root /
  infrastructure directly rather than going through a port (application ->
  infra direct import).

These are currently benign (no circularity, no cross-module coupling), but the
whole point of adding the rules was to keep them that way automatically.

### 3. Task 6''s planned deployments/domain/ layer does not exist

The plan''s future-state tree explicitly lists:

    domain/
      deployment-target.ts        # aggregate and lifecycle rules
      provider-connection.ts      # entity rules, never credential I/O
      environment-scope.ts        # lane/branch value object
      deployment-target.policy.ts # provider-neutral policy

None of these files exist. There is no `domain/` folder inside deployments at
all. The invariants they were supposed to hold do exist, but scattered:

- Provider/slot compatibility lives as a private method
  (`assertProviderSlotAllowed`) on DeploymentTargetsService.
- EnvironmentScope lane/branch validation lives inline in EnvVarsService.
- BYO credential must reference active ProviderConnection is checked in
  DeploymentTargetsService line ~845.
- Lifecycle transition rules: no explicit state machine found; status is set
  ad hoc based on provider query results.

Per the backend-architecture skill this is a legitimate progressive-depth
choice (Level 2/3), but it deviates from what the plan itself committed to,
and the DDD_CONTEXT_MAP.md still describes these as if they live in a domain
layer.

### 4. Task 6 Step 1''s application/ports/deployment-provider.port.ts was never created

The plan called for a dedicated ports folder under application/. Instead, the
contract lives at infrastructure/providers/core/deployment-provider.contract.ts
-- which works (Render and Vercel both implement it), but puts a port where
the plan expected infrastructure to consume it from above. Combined with gap 2
(no enforcement), nothing prevents an application service from importing a
specific provider client directly.

### 5. Task 6 Step 4''s contract suite covers only structural presence, not behavior

provider-contract.suite.ts checks that each adapter has seven methods defined
(typeof === ''function''), nothing more. The plan said "connection validation,
target lifecycle, environment variable synchronization, public/dashboard URLs,
CI secret installation, and deployment history" should be covered by the
contract. In reality:

- No URL operations in the contract (public URLs handled separately by
  provider-public-url.ts free function).
- No CI secret installation operation (handled by separate
  render-ci-secrets/vercel-ci-secrets services).
- No deployment history operation (handled by application-layer services
  calling providers through a different path).
- No behavioral assertions at all -- just "does the method exist."

So the contract suite gives false confidence: it passes for any object with
seven functions named right, regardless of whether those functions behave
correctly.

### 6. SubscriptionGuard deep-imports SubscriptionService (still unfixed)

src/common/guards/subscription.guard.ts line 11 imports
`SubscriptionService` from
`''../../modules/subscription/subscription.service''`, bypassing
modules/subscription/index.ts which exports exactly that class. Same problem
in its spec file. And src/modules/auth/auth.controller.spec.ts has the same
deep import in tests.

dependency-cruiser doesn''t catch these because the `no-deep-module-imports`
rule only fires when the *importer* also lives under src/modules/. Imports
from src/common/, src/config/, src/scripts/, etc., into module internals are
invisible to the checker.

Also: src/scripts/reconcile-deleted-repos.ts deep-imports ProjectsService
rather than going through modules/projects/index.ts.

### 7. Task 1''s architecture spec is a tautology, not a real gate

tests/architecture/module-boundaries.spec.ts reads .dependency-cruiser.cjs as
text and asserts that certain rule names appear in it. It does NOT run
depcruise, so it cannot detect actual violations. It would pass even if every
import in the codebase violated the boundary rules, as long as the config file
mentions the rule names. The plan''s Step 1 said "Write failing architecture
assertions" -- the assertion written here could never fail against any real
code change.

### 8. Task 11 Step 3 (release-equivalence verification) was skipped

The plan required: "Review observable behavior before merge. Compare generated
workflow fixtures, project setup responses, deployment history responses,
drift responses, auth/session behavior, and Render/Vercel provider contract
results against their pre-refactor tests." No evidence this comparison was
done beyond running the existing test suite. There are no snapshot/fixture
comparison tests, no commit messages mention release equivalence, and the
alignment review doc doesn''t reference this step either. The existing unit
tests all pass, which is good but not the same as proving byte-for-byte
compatibility.

### 9. CI workflow only triggers on main; boundaries aren''t enforced on trunk PRs

.github/workflows/boundaries.yml has `branches: [main]` for both push and
pull_request. Since the team''s current workflow merges into
codex/modular-monolith-trunk (not main), boundaries won''t run on trunk PRs --
which defeats the point during the refactor period. Needs updating to include
codex/modular-monolith-trunk.

### 10. Stale test directory name: tests/unit/modules/notifications/domain/

Task 10 renamed src/modules/notifications/domain/ to application/, but the
corresponding spec file still sits under
tests/unit/modules/notifications/domain/notification-events.service.spec.ts.
Cosmetic inconsistency, but confusing when navigating.

### 11. DDD_CONTEXT_MAP.md describes a structure that doesn''t exist yet

The context map references "DeploymentTarget lifecycle transition," 
"EnvironmentScope" as a value object, and "deployment-target.policy" as if
they''re implemented entities. They''re not -- they exist only as scattered
private methods (see gap 3). The map is aspirational, not descriptive, which
undermines its purpose as documentation.

### 12. No integration tests exist despite package.json referencing them

package.json''s jest roots includes `<rootDir>/tests/integration`, but that
directory doesn''t exist on disk (and never did in git). Running `npm test`
without overriding roots fails with a validation error. Either the directory
should be created with at least one placeholder spec, or the roots entry
should be removed.

---

## Non-gaps (confirmed clean)

- No remaining references to env-provisioning, modules/persistence, or
  modules/database in tracked source or tests.
- Every module (17 total) has an index.ts public API.
- Kernel never imports from modules (verified by grep + depcruiser rule).
- RenderEnvClient and VercelEnvClient both implement the DeploymentProvider
  interface.
- No provider-to-provider cross imports.
- REST paths preserved (env-vars, deployment-targets, provider-connections all
  match pre-refactor paths).
- ENV_PROVISIONING_* env vars / env_provisioning Postgres schema names remain
  unchanged (correct per plan''s compatibility contract -- these are runtime
  identifiers, not module paths).

---

## Recommended fix order

1. Add the missing dependency-cruiser rules from Task 6 Step 3 (gap 2). Small,
   high-leverage change that makes future regressions impossible.
2. Fix the subscription-guard and reconcile-scripts deep imports (gap 6) while
   widening the depcruiser `from` pattern to cover src/common, src/config,
   src/scripts, and src/health.
3. Update boundaries.yml to trigger on codex/modular-monolith-trunk (gap 9).
4. Move the notifications test folder from domain/ to application/ (gap 10).
5. Create tests/integration/ with at least one placeholder spec, OR remove the
   roots entry from package.json (gap 12).
6. Replace the architecture spec''s text-matching with an actual depcruise
   invocation (gap 7).
7. Strengthen the provider contract suite to assert behavior, not just method
   existence (gap 5).
8. Tackle ProjectsService decomposition properly (gap 1) -- move one workflow
   group at a time out of ProjectsService and into the existing application
   service shells, leaving ProjectsService as the delegating facade the plan
   originally intended.
9. Reconcile DDD_CONTEXT_MAP.md with reality: either build the planned domain/
   layer or update the map to describe where the invariants actually live
   (gaps 3, 11).
