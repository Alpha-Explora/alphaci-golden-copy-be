# Modular-Monolith Implementation Report

**Date:** 2026-08-25
**Branch:** codex/modular-monolith-boundaries (trunk: codex/modular-monolith-trunk)
**Scope:** verify the implementation against the boundary-restoration plan and
the backend-architecture skill; identify legacy leftovers and further
improvements.

## Summary

The plan's 11 tasks are all committed and the hard architectural goals are
genuinely met: zero dependency-cruiser violations (with and without the
baseline file), a clean kernel with no feature imports, a real DDD context
map, and a deployments module that owns provider adapters behind one public
facade. All verification commands pass locally. Two categories of gap remain:
a handful of small leftover/enforcement items (cheap to close), and one
larger, honestly-labeled gap -- `ProjectsService` (4,194 lines) was wrapped
with six focused application services rather than actually decomposed, so the
"Level 2/3 progressive depth" the skill asks for is not yet reached for the
Projects module specifically.

## Verification evidence (re-run today)

| Command | Result |
| --- | --- |
| `npm run boundaries` | 0 violations (281 modules, 1,129 dependencies) |
| `npm run boundaries:new` | 0 violations -- baseline file is genuinely `[]` |
| `npm run typecheck` | passed, 0 errors |
| `npm test -- --runInBand` | 99 suites / 1,150 tests passed |
| `npm run test:e2e` | 2/2 passed |
| `npm run build` | passed |
| `npm run lint` | 751 errors, all CRLF (`prettier/prettier`), see below |

Two environment notes surfaced during verification, now corrected:

1. `node_modules` had to be restored via `npm ci` (system Node/npm, escalated
   once) after an earlier `pnpm run boundaries` attempt deleted it inside a
   network-isolated sandbox. `package.json`/`package-lock.json` were untouched
   throughout, so this was a clean, lossless recovery. **This repo's package
   manager is npm** -- the untracked `pnpm-workspace.yaml` and `.pnpm-store/`
   in the working tree are stray artifacts from that mistaken invocation and
   should be deleted, not committed.
2. The 751 lint errors are 100% CRLF-insertion findings, confirmed
   environmental: this machine has `core.autocrlf=true`, the repo has no
   `.gitattributes`, and `git show HEAD:<file>` proves every committed blob is
   pure LF. Real code, not a regression from this plan -- but it means *any*
   Windows contributor without the right git config will see the same 751
   "errors" on files they never touched. Worth fixing once, repo-wide (see
   Recommendations).

The alignment review at [docs/architecture/BACKEND_ARCHITECTURE_ALIGNMENT_REVIEW.md](docs/architecture/BACKEND_ARCHITECTURE_ALIGNMENT_REVIEW.md)
has been updated with these confirmed, re-run numbers.

## Plan alignment, task by task

| Task | Status | Evidence |
| --- | --- | --- |
| 0. DDD context map | Done | [docs/architecture/DDD_CONTEXT_MAP.md](docs/architecture/DDD_CONTEXT_MAP.md) matches the plan's bounded contexts, invariants, and anti-corruption rules exactly. |
| 1. Baseline + characterization | Done | `tests/architecture/module-boundaries.spec.ts` exists and passes; baseline is empty. |
| 2. Deployment provisioning facade | Done | `deployments/index.ts` exports the facade, tokens, and contract types only. |
| 3. Break projects/deployments cycle | Done | 0 circular-dependency findings; contracts live in deployments, not projects. |
| 4. Kernel db + auth contracts | Done | `src/kernel/db`, `src/kernel/auth/session-user-lookup.contract.ts`; `SessionAuthGuard` depends on the contract, not a repository. |
| 5. Dissolve PersistenceModule | Done | `modules/persistence` and `modules/database` no longer exist; repositories moved to owning modules' `infra/`. |
| 6. Modularize provider adapters | Mostly done | Providers live under `deployments/infrastructure/providers/{core,render,vercel}`; no cross-provider imports. **Gap:** Step 3's deployments-specific layer rules (domain can't import Nest/pg, api can't import infra/providers, providers can't import each other) were never added to `.dependency-cruiser.cjs` -- currently clean by convention only, not enforced. |
| 7. Isolate deployment reads/drift | Done | `project-deployments.service.ts` and `project-drift.service.ts` live in `deployments/application/`, exported via facades. |
| 8. Canonicalize deployments | Done | `modules/env-provisioning` no longer exists; `modules/deployments` is the sole boundary. |
| 9. Split ProjectsService by workflow | **Partial** | See "ProjectsService decomposition" below. |
| 10. Public module APIs + notifications layer fix | Done | Every module has `index.ts`; `notifications/domain` renamed to `notifications/application`. |
| 11. Zero baseline + release verification | Done | See verification table above. |

## ProjectsService decomposition (Task 9) -- the one real gap

Task 9 asked for `projects.service.ts` to be divided into coherent
application services, with `ProjectsService` staying only as a temporary
compatibility facade during migration. What actually landed:

- `projects.service.ts` is still **4,194 lines** (was 4,548) -- a ~8% trim,
  not a decomposition.
- Six services exist under `projects/application/` and `projects/`:
  project-lifecycle, project-dashboard, project-workflows, project-previews,
  project-drift-repair, project-provisioning.
- Of those, **project-previews and project-drift-repair are real**,
  independent implementations with their own logic.
- **project-dashboard is a pure pass-through** -- every method calls straight
  into `this.projectsService.<sameMethod>()`. project-lifecycle and
  project-workflows are a mix of new logic and delegation back into
  `ProjectsService`.
- The controller reflects this split honestly: it calls the new services with
  a fallback, e.g. `this.projectDashboardService?.getProjectOverview(id, userId)
  ?? this.projectsService.getProjectOverview(id, userId)`. `ProjectsService`
  is still called directly 15 times for routes that were not migrated.

Net effect: the seam exists and is safe to keep building on (nothing is
duplicated or diverging), but the stated goal of Task 9 -- shrinking the
4,548-line hotspot the review itself flagged as the top complexity risk --
is not yet achieved. This is the same conclusion the alignment review already
drew ("Primary hotspot... Extract workflows within the module"); it just
hadn't been checked against the actual file sizes until now.

## Legacy/leftover findings (fixed during this review)

- `src/modules/database/` and `src/modules/persistence/` existed as **empty,
  untracked directories** left over from the `git mv`-style migrations
  (git doesn't track empty dirs, so this was invisible to `git status`).
  Deleted.
- `src/modules/deployments/provider-clients/` was the same kind of empty
  leftover from Task 6's move to `infrastructure/providers/`. Deleted.
- No stale source actually imports `env-provisioning`, `modules/persistence`,
  or `modules/database` -- confirmed with a repo-wide search. The rename and
  dissolution were both completed cleanly in the tracked source.

## One real boundary gap the dependency-cruiser config misses

`src/common/guards/subscription.guard.ts` imports
`SubscriptionService` directly from `'../../modules/subscription/subscription.service'`
instead of through `modules/subscription/index.ts` (which already exports
exactly that service). This is a genuine deep-module import, but
dependency-cruiser's `no-deep-module-imports` rule only fires when the
*importer* also lives under `src/modules/` -- so an import from
`src/common/` into a module's internals is currently invisible to
`npm run boundaries`. It works today because Nest resolves it fine, but it is
exactly the kind of import the plan's Task 6/10 intent was to prevent, and it
sits in the shared-guard code the plan explicitly called out in "Required
change #6." Recommend switching the import to `from '../../modules/subscription'`
and widening the dependency-cruiser rule's `from` pattern to also cover
`src/common/`, `src/config/`, and `src/health/` (anything outside
`kernel/`+`modules/` that isn't the composition root) so this class of gap is
caught automatically next time.

## Skill alignment (backend-architecture)

- **Progressive depth:** matches the skill's guidance well. Deployments sits
  at Level 2/3 (real invariants like provider/slot compatibility and
  lifecycle transitions, enforced in `deployment-targets.service.ts` rather
  than over-engineered into a formal aggregate class) -- consistent with the
  skill's instruction to add domain modeling "only when complexity justifies
  it." The DDD_CONTEXT_MAP's proposed `domain/` layer for deployments
  (DeploymentTarget, ProviderConnection, EnvironmentScope as explicit
  classes) was intentionally not built, and per the skill that's a legitimate
  choice, not a defect -- the invariants exist and are tested, just as
  private methods on an application service instead of named domain objects.
  If the domain layer is wanted later, promote `assertProviderSlotAllowed`
  and friends out of `deployment-targets.service.ts` into a policy class.
- **Dependency rules:** correctly enforced for the case the skill cares about
  most -- cross-module access goes through a public API, kernel never imports
  a feature, no cycles. The one gap is the subscription-guard deep import
  above, which the skill's "cross-module access should use a small public
  API" principle would also flag.
- **Module shape:** intentionally not uniform across modules, and that is
  fine per the skill ("Some frameworks may place controllers... differently.
  That is acceptable if ownership and dependency direction remain clear").
  Small modules (audit, usage, capabilities, catalog) stay flat with a
  `dto/` folder; modules with real infra or cross-module surfaces
  (auth, subscription, ci, workflows, notifications, deployments) have
  `infra/`/`application/` folders. This matches the skill's "default module
  shape... not a mandatory folder layout" instruction.
- **Testing shape:** matches well -- 99 unit/architecture suites plus 2 E2E,
  an explicit `tests/architecture/module-boundaries.spec.ts` that protects
  the rules programmatically, and provider contract-suite tests
  (`provider-contract.suite.ts`) so Render and Vercel adapters are held to
  the same behavior. This is exactly the skill's "test infrastructure
  adapters against... a faithful harness" guidance.

## Recommendations, ranked

1. **Finish the ProjectsService split (Task 9's actual goal).** Pick one
   remaining workflow group at a time (dashboard first, since it is already a
   thin wrapper and has the lowest risk) and move the real implementation out
   of `projects.service.ts` into the application service, leaving
   `ProjectsService` calling *out* instead of being called *through*. This is
   the highest-value remaining change since it's the one the review already
   flagged as the top complexity/risk hotspot.
2. **Add the missing deployments-specific dependency-cruiser rules from Task
   6, Step 3** (domain independent of Nest/pg, api can't reach
   infrastructure/providers directly, providers can't import each other).
   Currently true by convention only.
3. **Fix the subscription-guard deep import** and broaden the
   `no-deep-module-imports` rule's `from` pattern so imports from
   `src/common/`, `src/config/`, and `src/health/` into module internals are
   caught too, not just module-to-module imports.
4. **Add a `.gitattributes`** (`* text=auto eol=lf`) so the 751 CRLF lint
   findings stop appearing for every Windows contributor -- this is a
   one-time fix, not something to keep tolerating per-machine.
5. **Delete the untracked `pnpm-workspace.yaml` and `.pnpm-store/`** from the
   working tree; this repo's package manager is npm.
6. Everything else from the plan is done and verified; no other action needed
   before continuing feature work (e.g. the GCP provider) on top of this
   branch.
