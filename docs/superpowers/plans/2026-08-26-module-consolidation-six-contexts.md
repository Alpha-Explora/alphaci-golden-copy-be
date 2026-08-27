# Module Consolidation Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.
> Work one task at a time, in order. Do not start a task whose exit criteria
> depend on an unfinished predecessor.

**Goal:** Reduce 17 modules to 6 bounded contexts and preserve a safe future
service-extraction option, without altering observable behaviour. Microservice
extraction is not an implementation task in this plan.

**Design doc:** `docs/architecture/MODULE_CONSOLIDATION_PLAN.md` (current vs
future state, full trees, measured coupling). This document is the executable
sequence for that design.

**Prior art:** `C:\Users\anton\Codes\Alpha Explora\AlphaCi\alphaci-be` — the
sibling repo that did the same decomposition as real microservices. Its
`docs/architecture/hexagonal-hybrid.md` and four `scripts/*.cjs` gates are the
source for several tasks below. Take its **mechanisms**, not its topology.

**Tech stack:** NestJS 11, TypeScript 5 (`strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`), PostgreSQL via `pg` + Supabase, Jest + ts-jest,
dependency-cruiser.

**Execution status (2026-08-28):** Tasks 0–10 and the review-closure slices are
implemented on the named remediation trunk. The continuous regression safety
net has current contract snapshots, a recovered pre-consolidation route
reference from `b175938` with hashes, application-context and real HTTP boot
harnesses, and conditional Postgres integration coverage. The source commit
did not contain a pre-consolidation contract snapshot, so that comparison
remains unavailable. Microservice extraction is intentionally outside this
plan and remains a future option documented in `docs/architecture/FUTURE_STATE.md`.
Final verification and the rollback evidence record are maintained in
`docs/architecture/REMEDIATION_EVIDENCE.md` before this plan is marked complete.

---

## Global constraints

- No endpoint, request DTO, response DTO, status code, authorization rule,
  provider behaviour, database value, or existing event payload may change.
- Every task runs: `npm run typecheck`, changed-file lint, `npm test`, and
  `npm run boundaries`. Global `npm run lint` is reported separately when
  pre-existing baseline findings exist; it must not regress.
- The dependency-cruiser known-violations baseline may shrink, never grow.
- `kernel/` may never import from `src/modules/`.
- Cross-context callers import only a context's `index.ts` or `contracts/`.
- **Ports only where 2+ implementations exist.** See §"Port discipline" below.
- `git mv` for moves. No logic edits in the same commit as a move.
- One task per PR unless a task explicitly says otherwise.

## Port discipline (learned from alphaci-be, do not relearn)

The sibling repo wrote ~27 in-process adapters and **deleted 24 of them** as
dead code (finding #2 in its audit). Its resulting rule, stated three times in
its spec:

> Same process + same schema → concrete class in `infrastructure/`.
> 2+ implementations (HTTP fallback, second DB, test substitute that pays)
> → extract a port. No blanket interfaces.

Applied here:

| Cross-context edge needs | Deliverable |
|---|---|
| decoupled types | `contracts/` type — **all 15 edges get this** |
| a second implementation or real seam | `application/ports/*.port.ts` + token — **only ~5–7 edges** |
| nothing else | direct call through the owning context's `index.ts` |

Do **not** mechanically create 15 ports. Task 4 names the ones that qualify.

## Verification loop

```bash
npm run typecheck
npm run lint
npm test
npm run boundaries
npm run check:application-boundaries   # added in Task 2
npm run check:schema-ownership         # added in Task 8
npm run report:architecture-metrics    # added in Task 2
```

---

## Task 0: Establish a runnable baseline — DONE (with findings)

**Status: complete.** Baseline recorded in
`docs/architecture/CONSOLIDATION_BASELINE.md`. Measured at HEAD `b175938` on
this machine (bundled Node 24 + pnpm via `pnpm import` from
`package-lock.json`; see the baseline doc for environment deviations):

| Gate | Result |
|---|---|
| typecheck | PASS, zero errors |
| test | PASS — **114 suites / 1206 tests** |
| boundaries | PASS — 312 modules, 1260 deps, 0 violations |
| lint | **FAIL — 434 errors in 70 files** (pre-existing; lint was never a CI gate) |

Lint breakdown: ~167 CRLF checkout artifacts (Windows-only phantom failures),
~235 real prettier drift (auto-fixable), 22 unused imports mostly in
`projects.service.ts`, 13 misc type-aware errors.

- [x] Step 1: dependencies installed (pnpm from npm lockfile;
  `pnpm-lock.yaml` created, untracked — do not commit without discussion)
- [x] Step 2: baseline captured in `docs/architecture/CONSOLIDATION_BASELINE.md`
- [x] Step 3: fix stale boundary comment in `.github/workflows/boundaries.yml`
  (claims 197 baseline violations; actual `[]`)

**Carried into Task 1:** lint debt must be triaged before CI enforces it —
add `.gitattributes` (`*.ts text eol=lf`) or set `endOfLine: 'auto'` for the
CRLF artifacts, then `eslint --fix` plus removal of the 22 dead imports for
the rest.


---

## Task 1: Widen CI to a real gate

`.github/workflows/boundaries.yml` is the only workflow, and it runs only
`npm run boundaries`. A refactor of this size cannot be defended by one gate.

**Files:**
- Modify: `.github/workflows/boundaries.yml` (or add `.github/workflows/ci.yml`)

- [x] **Step 1: Add typecheck, lint, and test jobs.**

    GitHub Actions minutes have been constrained on this account. The sibling
    repo handles this with `on: workflow_dispatch` only and a comment
    explaining why. Copy that posture if minutes are still unavailable: a
    dispatchable workflow that runs the full loop beats no workflow.

- [x] **Step 2: Verify the minutes situation before relying on CI.**

    Do not assume hosted runners are available. If they are not, every task
    below runs its verification loop locally and the PR body records the
    output. The workflow uses dispatch plus push-to-main; the local loop is the
    enforcement path until hosted minutes are confirmed.

**Exit:** a single workflow runs the full verification loop, dispatchable or
automatic.

---

## Task 2: Port two architecture gates from alphaci-be

These are self-contained Node scripts with zero dependencies. Copy, then adapt
paths from `apps/<app>/src/` to `src/modules/<module>/`.

**Files:**
- Create: `scripts/check-application-boundaries.cjs`
- Create: `scripts/report-architecture-metrics.cjs`
- Modify: `package.json` (two scripts)

**Source:** `alphaci-be/scripts/check-application-boundaries.cjs` and
`alphaci-be/scripts/report-architecture-metrics.cjs`

- [x] **Step 1: Port the application-boundary gate.**

    Fails when a file under `application/` imports `infrastructure/`, with a
    deliberate carve-out for own-schema repositories
    (`/infrastructure/[^/]*\.repository$`). Adapt `appNameOf()` to read
    `^src/modules/([^/]+)/`.

    This immediately catches a real case dependency-cruiser misses:
    `src/modules/deployments/application/project-sync-findings.repository.ts`
    is a repository sitting in the application layer.

- [x] **Step 2: Port the metrics reporter.**

    Emits per-module counts (domain files, application files, ports, infra
    imports, forbidden imports, cross-module imports) plus `--json`. This is
    how progress becomes a number per PR instead of an opinion.

- [x] **Step 3: Wire both into `package.json` and CI.**

    ```json
    "check:application-boundaries": "node ./scripts/check-application-boundaries.cjs",
    "report:architecture-metrics": "node ./scripts/report-architecture-metrics.cjs"
    ```

- [x] **Step 4: Record the starting metrics.**

    Append the initial table to `docs/architecture/CONSOLIDATION_BASELINE.md`.
    Expect a non-zero forbidden count from Step 1; fix it in Task 3, not here.

**Exit:** both scripts run; the metrics table is committed; the application
gate's initial violation list is documented.

---

## Task 3: Make cross-module imports move-proof

**This task decides whether Task 8 is a week or three.**

Measured on `HEAD`: **1,200 relative imports, 606 containing `../` across 240
files, and zero uses of the `@modules/*` / `@kernel/*` aliases** defined in
`tsconfig.json`.

The zero is not neglect — it is load-bearing. With `"module": "nodenext"`,
`tsc` emits import specifiers verbatim and Node ESM resolves them literally at
runtime. A relative path survives the build; an `@` alias string does not.
Adopting `@` aliases naively would pass typecheck, pass Jest, pass CI — and
crash `npm run start:prod`.

Node resolves this natively with **subpath imports**: entries under
`"imports"` in `package.json`, prefixed with `#`. No loader, no build step,
and TypeScript understands them under `nodenext`. Use those instead of `@`
aliases.

**Files:**
- Modify: `package.json` (`imports`, Jest `moduleNameMapper`)
- Modify: `tsconfig.json` (`paths` entries prefixed with `#`)
- Modify: ~240 `.ts` files under `src/` and `tests/` (codemod)

- [x] **Step 1: Define the subpath imports.**

    ```jsonc
    // package.json
    "imports": {
      "#kernel/*": {
        "types": "./src/kernel/*",
        "default": "./dist/src/kernel/*.js"
      },
      "#modules/*.js": {
        "types": "./src/modules/*",
        "default": "./dist/src/modules/*.js"
      },
      "#modules/*": {
        "types": "./src/modules/*",
        "default": "./dist/src/modules/*.js"
      },
      "#common/*.js": {
        "types": "./src/common/*",
        "default": "./dist/src/common/*.js"
      },
      "#common/*": {
        "types": "./src/common/*",
        "default": "./dist/src/common/*.js"
      },
      "#config/*.js": {
        "types": "./src/config/*",
        "default": "./dist/src/config/*.js"
      },
      "#config/*": {
        "types": "./src/config/*",
        "default": "./dist/src/config/*.js"
      }
    }
    ```

    This repository's Nest compiler emits below `dist/src/` because
    `sourceRoot` is `src`; the runtime targets must match that observed build
    layout rather than assuming a flattened `dist/` tree. The `types` branch
    keeps static dependency analysis and TypeScript on source while Node uses
    the compiled `default` branch.

    Mirror them in `tsconfig.json` `paths` (`"#kernel/*": ["src/kernel/*"]`
    — pointing at `src`, since TS typechecks source) and in Jest
    `moduleNameMapper` (`"^#kernel/(.*)$": "<rootDir>/src/kernel/$1"`). The
    dist/src split is deliberate: runtime resolves against `dist`; TS and
    Jest against `src`.

- [x] **Step 2: Prove the full chain on exactly one import.**

    Convert one cross-module import. Then verify all three consumers of the
    specifier: `npm run typecheck`, that file's Jest suite, **and**
    `nest build` followed by resolving the built file from `dist/`. A
    specifier that passes the first two but fails the third is exactly the
    failure mode that made this team avoid aliases. Do not proceed until the
    built artifact itself resolves.

- [x] **Step 3: Codemod escaping imports.**

    Rewrite only specifiers that escape their own module or reach shared
    code:

    ```text
    ../../kernel/db/database.service.js  → #kernel/db/database.service.js
    ../../deployments/index.js           → #modules/deployments/index.js
    ../../common/guards/…               → #common/guards/…      (temp alias)
    ../../config/app.config.js           → #config/app.config.js (temp alias)
    ```

    Leave intra-module relative imports alone; they move together and stay
    correct. Preserve `.js` extension specifiers. Path-resolving script, not
    a bare regex.

- [x] **Step 4: Verify and commit as one mechanical change.**

    Full verification loop **plus a resolution smoke of `dist/`**. The diff
    is large but every hunk is a string substitution; say so in the PR body
    with file counts. The application boundary findings discovered by Task 2
    were closed in the same behavior-preserving slice: provider clients now
    enter application services through an application port, and the project
    sync repository is under infrastructure/.

**Exit:** every cross-module, kernel, `common/`, and `config/` import is a
`#` specifier; all four gates green; the built `dist/src/` resolves them.

**Task 3 verification:** 428 import substitutions across 212 files; the
codemod is idempotent; typecheck, lint, Jest, dependency-cruiser, and the
application-boundary gate pass. `nest build` emits `dist/src/`, and Node
`require.resolve('#modules/deployments/index.js')` resolves the compiled file.

**Why not the sibling repo's mechanism:** `alphaci-be` resolves `@alphaci/*`
at runtime through real npm workspace packages with `exports` fields. Correct
once libraries exist as packages; here it means scaffolding packaging
infrastructure for zero packages. Subpath imports buy the same guarantee in
six lines. If TypeScript fights the `#` paths, fall back to `@` aliases in
tooling plus `node --import tsconfig-paths/register dist/main.js` for prod —
but try `#` first; it needs no runtime flag.


---
---

## Task 4: Freeze the rules — context tags and new boundary rules

Context-level rules must exist while the folders are still 17, so Task 7's
moves are checked rather than trusted.

**Files:**
- Modify: `.dependency-cruiser.cjs`
- Create: `scripts/check-provider-encapsulation.cjs`
- Modify: `package.json`

- [x] **Step 1: Add a context tag per module.**

    Encode the 17→6 mapping once, as data, in `.dependency-cruiser.cjs`:
    `identity-access` ← auth, admin, capabilities, workspaces, hierarchy;
    `projects` ← projects, catalog, workflows, existing-repos;
    `pipelines` ← github, ci; `runtime` ← deployments;
    `billing` ← subscription, usage;
    `platform-ops` ← notifications, feedback, audit.

- [x] **Step 2: Add `no-cross-context-cycles` at `warn`.**

    Two cycles exist today (Task 6). `warn` now, `error` after Task 6.

- [x] **Step 3: Add `contracts-are-dependency-free` at `error`.**

    Nothing under `*/contracts/` may import `@nestjs/*`, `pg`, `@supabase/*`,
    or any `infrastructure/` path. This is the rule that makes `contracts/`
    publishable later without dragging the framework along.

- [x] **Step 4: Add `no-provider-literals-outside-runtime` at `warn`.**

    `'render'`, `'vercel'`, `'gcp'` may not appear outside
    `src/modules/deployments/**`. Four known leaks (Task 5) must be fixed
    before this becomes `error`.

- [x] **Step 5: Move the shared surface into the kernel.**

    Three `git mv` groups:

    a. App-wide guards — `src/common/guards/{session-auth,subscription,
       dev-only}.guard.ts` and their specs → `src/kernel/auth/`. Doing this
       now means Task 8.3 does not move guards and rewire authorization in the
       same PR as a 95-file folder move.

    b. Config and HTTP cross-cutting — `src/common/config/*`,
       `src/common/filters/*`, `src/common/middleware/*`, and
       `src/config/app.config.ts` → `src/kernel/{config,http}/`. Measured
       blast radius: **79 files import these paths**, including `main.ts`.
       This is why Task 3 created temporary `#common/*` / `#config/*`
       aliases: the codemod already rewrote all 79 call sites, so this step
       only moves the target folders and updates six lines in `package.json`.

    c. Update `main.ts` imports explicitly — it is outside the codemod's
       cross-module scope but imports three of the moved files.

- [x] **Step 6: Delete the temporary aliases.**

    Remove `#common/*` and `#config/*` from `package.json`, `tsconfig.json`,
    and Jest mapping. Nothing may import them anymore.

**Exit:** new rules land green; guards live in `kernel/auth/`; `src/common/` is
deleted and its imports resolve through the kernel. The subscription guard uses
a kernel-owned entitlement port so kernel remains independent of billing.

---

## Task 5: Contain provider identity inside `runtime`

Provider literals appear in three *other* future contexts. Today that is
untidiness; after Task 7 it means `billing`, `identity-access`, and `projects`
cannot compile without knowing `runtime`'s provider list — the opposite of a
plugin.

Three of the four fixes use the metadata registry that already exists.

**Files:**
- Modify: `src/modules/usage/usage-quota.service.ts`
- Modify: `src/modules/capabilities/capabilities.controller.ts`
- Modify: `src/modules/workflows/staged-workflow.builder.ts`
- Modify: `src/modules/projects/dto/create-project.dto.ts`, `projects.service.ts`
- Create: `src/modules/deployments/core/deployment-usage.contract.ts`
- Create: `src/modules/deployments/core/workflow-fragment.contract.ts`

- [x] **Step 1: De-provider the quota SQL.**

    `usage-quota.service.ts` selects `managed_render_services` and
    `managed_vercel_projects` with `provider = 'render'` / `'vercel'`
    literals, and branches on `renderManagedFleetMax` vs
    `vercelManagedFleetMax`.

    Replace with a `DeploymentUsageFact` contract published by `deployments`,
    counting by ownership mode and provider id as *data*. Quota limits become
    a keyed lookup, not a ternary.

    **Reality check before starting:** the response shape feeds the frontend
    quota display. Keep `managed_render_services` /
    `managed_vercel_projects` as field names (or version the response) so the
    FE does not change. Capture the current response JSON before touching
    anything and diff after. Highest-risk step in the task because it rewrites
    SQL; assert identical numbers before and after.

- [x] **Step 2: Make the capabilities endpoint read the registry.**

    `capabilities.controller.ts` returns hardcoded `['render','vercel']` and
    `['vercel']`. `GET /deployment-providers` already exists, backed by
    `DeploymentProviderRegistry`. Consume it.

    **Reality check:** the FE renders provider labels/icons from this payload.
    Registry-derived output must be filtered to the same hardcoded list until
    the FE confirms it handles arbitrary providers — otherwise enabling GCP
    silently changes what every client sees. Keep the response byte-compatible;
    widening it is an FE-coordinated follow-up, not part of this task.

- [x] **Step 3: Invert the workflow deploy jobs.**

    `staged-workflow.builder.ts` contains `vercelDeployJob()`,
    `renderDeployJob()`, provider-specific secret names, and provider-specific
    `uses:` refs. Each provider adapter contributes a `WorkflowFragment`
    (job YAML + required secret names); the builder composes fragments it does
    not understand.

    Emitted YAML must be byte-identical. Snapshot it before changing anything.

    **Scope note:** `workflows/dto/generate-workflow.dto.ts` also carries 8
    provider-specific fields (`renderServiceType`, `vercelOrgId`, secret-name
    maps). Those DTOs are the API contract for workflow generation — leave
    them alone here and record them as known debt for the provider-plugin doc.
    Removing them would break the generate-workflow endpoint contract.

- [x] **Step 4: Derive DTO validation from the registry.**

    Replace `@IsIn(['render','vercel'])` in
    `projects/dto/create-project.dto.ts` (two occurrences) and the matching
    type unions with registry-derived validation.

    **Reality checks:** class-validator decorators evaluate at decoration
    time, so the DTO uses the runtime-owned provider-id tuple rather than a
    Nest registry instance. This keeps validation synchronized without
    loading the deployment module graph at DTO import time; the dependency
    gate and full test suite confirm there is no circular import.
    Also note `create-deployment-target.dto.ts` legitimately keeps its
    provider config fields — they describe the provider being targeted; the
    gate targets literals in other contexts, not inside `runtime` itself.

- [x] **Step 5: Promote the gate.**

    `no-provider-literals-outside-runtime` → `error`. The diagnostic now exits
    non-zero on findings; the workflow-generation DTO is an explicit API
    contract exception and is recorded as known debt above.

    **Implementation note (2026-08-27):** provider metadata adapters now live
    in provider-owned folders, the generic slot policy is descriptor-driven and
    fails closed for unsupported slots, and workflow target expansion is
    contributed by provider fragments through `WorkflowFragmentRegistry`.
    The fake-provider acceptance test exercises those seams without changing
    the builder. Historical token, scope, storage, strategy, and workflow DTO
    compatibility fields remain inside `runtime` by design; removing them
    would change existing API or database behavior.

**Out of scope:** unifying the two registries (`DeploymentProviderRegistry` vs
`ProviderClientRegistry`), the two interfaces both named `DeploymentProvider`,
and the forked `env_provisioning.*` / `runtime_deployments.*` tables. That is
`docs/modular-architecture-deployments.md` and ships on its own schedule.

---

## Task 6: Break the two context cycles

Both are legal today because `no-circular` operates at file level and each edge
is a distinct file pair. Both become violations the moment contexts are the
unit, so they must be broken **before** the moves.

**Files:**
- Modify: `src/modules/hierarchy/repositories/repositories.service.ts`
- Modify: `src/modules/hierarchy/hierarchy.module.ts`
- Modify: `src/modules/auth/auth.module.ts`
- Modify: `src/modules/github/github-team-role.service.ts`
- Modify: `src/modules/github/github.module.ts`
- Create: two `*.port.ts` files (these qualify under port discipline — each
  breaks a cycle, which is a real seam)

- [x] **Step 1: Cycle A — `identity-access` ⇄ `projects`.**

    Inbound: `hierarchy/repositories/repositories.service.ts → projects/index`,
    plus `hierarchy.module.ts` and `auth.module.ts` importing
    `projects.module`. Outbound: `projects.service.ts → workspaces/index` and
    `→ hierarchy/project-link/index`, `workspace-gate.service.ts →
    workspaces/index`.

    Invert the inbound direction: introduce `ProjectLookupPort` consumed by
    `repositories.service.ts`. Nest composition-level imports count as cycle
    edges once contexts merge, so `hierarchy.module.ts` and `auth.module.ts`
    must stop importing `projects.module.ts` too.

- [x] **Step 2: Cycle B — `identity-access` ⇄ `pipelines`.**

    Inbound to `pipelines`: five files under `hierarchy/` and `auth/` import
    `github/index`. Outbound: `github-team-role.service.ts → admin/index` and
    `github.module.ts → admin.module`.

    Invert the smaller side: `github-team-role.service.ts` takes a
    `PlatformAdminPort` instead of importing `admin/index`.

- [x] **Step 3: Promote the gate.**

    `no-cross-context-cycles` → `error`.

**Exit:** zero context-level cycles. Runtime is the strongest future extraction
candidate, but the current measured graph still has three inbound context pairs,
four outbound pairs, and compatibility seams. That future option is not a
current deliverable or a configuration-only claim.

---

## Task 7: Publish cross-context contracts

All 16 current directional cross-context edges get a `contracts/` type. Only the edges that pass
port discipline also get a port.

**Files:**
- Create: `src/modules/<module>/contracts/*.ts` in each future context
- Modify: call sites to import from `contracts/` rather than service classes

- [x] **Step 1: Write the contract types.**

    Serialisable types only — no Nest decorators, no `pg`, no vendor SDKs.
    The `contracts-are-dependency-free` gate from Task 4 enforces this.

    Reference `alphaci-be/libs/contracts/src/` for shape: `events/registry.ts`
    with `EVENT_TOPICS` constants, per-topic Zod schemas, and
    `parseEventPayload()`; `interfaces/` for plain shared types.

- [x] **Step 2: Extract ports only where justified.**

    Candidates that qualify (second implementation, real seam, or extraction
    boundary):

    | Port | Edge | Why it qualifies |
    |---|---|---|
    | `ProjectLookupPort` | identity-access → projects | breaks Cycle A |
    | `PlatformAdminPort` | pipelines → identity-access | breaks Cycle B |
    | `DeploymentProvisioningPort` | projects → runtime | `runtime` is the first extraction candidate |
    | `DeploymentHistoryPort` | projects → runtime | already has a local + provider implementation |
    | `QuotaPort` | projects/runtime → billing | `billing` may be absent per edition |
    | `AuditEventPort` | 3 contexts → platform-ops | becomes the event boundary in Task 9 |

    Everything else calls through the owning context's `index.ts`. Do not
    create a port for a single in-process implementation.

- [x] **Step 3: Follow the sibling repo's file convention.**

    `application/ports/<name>.port.ts` exports the interface plus a
    `Symbol('<NAME>_PORT')` token; the adapter lives in
    `infrastructure/adapters/`. The current cycle-breaking ports live in the
    kernel port layer until physical context folders are consolidated; each
    documents the single swap point for a future out-of-process call.

Note: **17 spec files import other modules' internals** to build mocks. They are invisible to production gates; fix them opportunistically here (mock the contract/port instead) so Task 8 does not trip over them.

**Exit:** the contract register at
`docs/architecture/CROSS_CONTEXT_CONTRACTS.md` covers all 16 current
directional context pairs;
provider/runtime facts are published as contracts, and the two cycle-forming
service-class dependencies are port-inverted. Remaining synchronous service
index calls are intentionally retained until the physical consolidation and
outbox phases.

---

## Task 8: Physical consolidation — one context per PR

Order below is by ascending **touch count**, not by line count. Small modules
are not cheap: `platform-ops` is 1,130 lines but 32 files elsewhere import it,
while `projects` is 22,217 lines with only 5.

After Task 3 most moves no longer rewrite importers, which is what makes this
ordering affordable at all.

| # | Context | Folds | Files | Lines | External importers |
|---|---|---|---:|---:|---:|
| 8.1 | `runtime` | deployments (rename) | 97 | 17,795 | 15 |
| 8.2 | `projects` | projects, catalog, workflows, existing-repos | 81 | 22,217 | 5 |
| 8.3 | `identity-access` | auth, admin, capabilities, workspaces, hierarchy | 95 | 14,347 | 14 |
| 8.4 | `billing` | subscription, usage | 17 | 1,673 | 18 |
| 8.5 | `platform-ops` | notifications, feedback, audit | 20 | 1,130 | 32 |
| 8.6 | `pipelines` | github, ci | 33 | 8,095 | 34 |

### The hidden coupling: Nest composition imports

`no-cross-module-deep-imports` allows importing another module's
`*.module.ts` for Nest wiring. Measured: **every one of the 40 cross-module
edges carries both an `index.ts` import and a concrete `.module.ts` import**
— 40+ composition-level edges that dependency-cruiser cannot see and that
path aliases do not fix, because they are class references wired into
`imports: [...]` arrays.

When two modules merge into one context, those edges become ordinary internal
wiring — but the merged context's module graph must stay acyclic **at the
Nest level too**. `projects + workflows + catalog + existing-repos`, for
example, currently wires `workflows -> github`, `catalog -> github`,
`catalog -> subscription`, and `existing-repos -> subscription`; after the
merge those all point *into* the new context from inside it.

Therefore each consolidation PR starts by drawing the target provider graph on
paper (or in a comment) before moving anything:

- [x] Per-PR step 0: enumerate the incoming `*.module.ts` imports of every
  folded module; decide which survive as cross-context imports and which
  collapse to intra-context wiring. No move until this list is written down.

Per-PR rules:

- `git mv` only. No logic edits in a move commit.
- Normalise layer names on arrival: `presentation/` → `api/`, `infra/` →
  `infrastructure/`. Add `contracts/`. Never create an empty layer.
- Keep compatibility re-exports at old `index.ts` paths until the last PR of
  the task, then delete them in one cleanup commit.
- Run `npm run report:architecture-metrics` before and after; paste both into
  the PR body.
- Run the full app boot once per PR (`npm run start:prod` against a local DB,
  or `nest build` + `node dist/main.js --help` at minimum). Jest does not
  exercise Nest DI graphs; only booting does. A miswired provider graph passes
  every test and crashes at bootstrap.

- [x] **8.1 `runtime`** — mostly a rename of `deployments`. Layering is
  already correct. Move `application/project-sync-findings.repository.ts` into
  `infrastructure/repositories/` to clear the Task 2 gate. Providers move
  verbatim; do not touch `infrastructure/providers/`. Incoming composition
  edges to absorb: `deployments.module` imported by `projects`, plus core/GCP
  modules registered directly in `app.module.ts`.
- [x] **8.2 `projects`** — largest by lines, smallest by external touch.
  Group `application/` into `lifecycle/ dashboard/ drift/ workflows/ catalog/
  existing-repos/`. The 20 unlayered root files find homes here. Watch the
  `workflows -> github` and `catalog -> subscription` composition edges noted
  above.
- [x] **8.3 `identity-access`** — five modules, 95 files. Guards already
  moved in Task 4. `hierarchy`'s eight feature folders become
  `application/hierarchy/*`.
- [x] **8.4 `billing`** — small but widely imported. Compatibility re-exports
  matter most here.
- [x] **8.5 `platform-ops`** — 32 external importers. `notifications` already
  has the target shape.
- [x] **8.6 `pipelines`** — highest touch count, done last. GitHub webhook
  routes must not move.

### Test coupling debt

17 spec files import other modules' internals to build mocks (e.g.
`projects.service.spec.ts` touches catalog, ci, github, workspaces). These are
invisible to production gates and break loudly during Task 8. Fix them in the
same PR as the move they break: replace deep-import mocks with mocks of the
public contract or port token from Task 7. Budget roughly half a day extra
per consolidation PR for this.

**Exit:** `src/modules/` contains exactly six directories; `src/common/` and
`src/config/` are gone; all gates green **including one full boot per PR**;
no compatibility shims remain; no spec file imports across contexts.

**Implementation note (2026-08-27):** the six directories now exist and all
static gates plus the full Jest suite pass. The boot smoke reaches Nest
startup when the workspace's existing pnpm `express` package path is supplied,
then stops on the expected missing `NODE_ENV`; the default workspace install
also lacks the root `express` peer symlink. This is an environment/install
baseline, not a consolidation failure. The incoming composition inventory is
recorded in `docs/architecture/TASK8_RUNTIME_MOVE.md`.


---

## Task 9: Schema ownership

Import gates do not catch inline SQL. This is the known hole flagged in earlier
architecture work, and the sibling repo already built the fix.

**Files:**
- Move: `supabase/migrations/*.sql` → `supabase/migrations/<owner>/*.sql`
- Create: `scripts/check-schema-ownership.cjs`
- Modify: `package.json`, CI workflow

**Source:** `alphaci-be/scripts/check-db-schema-ownership.cjs` (63 lines)

- [x] **Step 1: Sort migrations into per-owner folders.**

    The gate reads `<root>/<owner>/*.sql`. Enterprise-be's migrations are
    flat, so this is a `git mv` exercise first. Renaming a migration file must
    not change replay order — verify against a cold replay before merging.

- [x] **Step 1b: Update the two migration runners for folders.**

    Both runners assume a flat directory:

    - `scripts/apply-migrations.ts` resolves files as
      `supabase/migrations/<name>` by explicit filename.
    - `scripts/apply-all-migrations.mjs` does `readdirSync(migrationsDir)
      .filter(.sql).sort()` — lexical order across the flat listing.

    After sorting into owner folders, apply-all must walk subdirectories and
    merge-sort by the timestamp prefix; apply-migrations should accept a bare
    name or `<owner>/<name>`. Verify with `--dry-run`: the printed sequence
    must be byte-identical to today's flat order. Measured: only these two
    scripts read the migrations path, but re-verify before merging.

- [x] **Step 2: Port the gate and write the allowlist.**

    The sibling repo's allowlist already answers our open question about the
    forked deployment tables — it keeps both under one owner:

    ```js
    runtime: new Set(['runtime', 'env_provisioning',
                      'runtime_deployments', 'runtime_domains']),
    ```

    Adopt that decision: `runtime` owns both schema families. Derive the rest
    from the six contexts.

- [x] **Step 3: Extend beyond foreign keys.**

    The sibling gate checks `REFERENCES <schema>.<table>` only. Extend the
    pattern to `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, and `DELETE FROM`
    schema-qualified references in repository SQL, which is where the real
    cross-context reads hide.

- [x] **Step 4: Wire into `package.json` and CI.**

Implementation note (2026-08-27): 63 migrations were present, not 89. They
are now under the six owner folders. The replay runner globally sorts the
timestamp basename, and the schema gate reports the explicit legacy
cross-context migrations while rejecting new ownership violations. The owner
table is published in `docs/architecture/SCHEMA_OWNERSHIP.md`. The extended
SQL-token scan covers migration SQL and inline SQL in source; deliberate
historical cross-context references are explicit per-file allowances, so a
new reference fails without a blanket filename exemption.

**Exit:** the ownership table is published, the gate is green, and no schema,
DB role, or `search_path` change was made.

---

## Task 10: Async-ify the sink edges

Before this task, `platform-ops` received 15 inbound imports (audit +
notifications) and made zero outbound calls. Every one of those writes
tolerates staleness.

**Files:**
- Create: `src/kernel/events/platform-event.registry.ts`
- Modify: `src/kernel/events/` (publisher + relay support)
- Modify: audit/notification call sites in the affected contexts

- [x] **Step 1: Define the topic registry.**

    Copy the shape of `alphaci-be/libs/contracts/src/events/registry.ts`:
    topic constants and runtime payload parsing. The implementation uses
    `PLATFORM_EVENT_TOPICS` and `decodePlatformEvent()` so freeform topic
    strings cannot reach a handler.

- [x] **Step 2: Convert audit and notification calls to outbox writes.**

    `kernel/events/outbox.repository.ts` already exists. Add the compiled
    `scripts/process-outbox.cjs` runner and `OutboxRelayService`; keep delivery
    in-process.

- [x] **Step 3: Keep dispatch in-process and single-consumer.**

    The sibling repo's scope rule adapted: only events with a real consumer
    travel anywhere; here every consumer is in-process, so no broker, no
    Pub/Sub, no DLQ.

- [x] **Step 4: Decide delivery guarantees explicitly.**

    The outbox row is durable when it is written in the same transaction as a
    critical business mutation, so a crash before dispatch leaves the row
    pending for the scheduled relay. A handler failure also leaves the row
    pending with backoff. A crash after the handler performs its side effect but
    before the published update can cause a repeat, so delivery is at-least-once
    and handlers must be idempotent. Best-effort audit/notification writes can
    still be dropped if their separate queue write fails. Write these guarantees
    down in the contracts doc. Add the sibling repo's `IdempotentInboxRepository`
    pattern only if/when a broker introduces redelivery (their finding #8: it
    sat unused for a full phase).

    Also verify `scripts/process-outbox.cjs` and any new relay do not
    double-dispatch the same rows — one owner per outbox table, stated in
    code, not assumed.

**Exit:** the audit/notification write edges now use the kernel outbox seam;
the platform-ops consumer is single-consumer and in-process. The security-
sensitive `admin -> audit.recordAlwaysOn` call and the project audit read
remain synchronous by design; they are not asynchronous sink edges.

**Implementation note (2026-08-27):** completed. The topic registry and
runtime payload validation are in `src/kernel/events/platform-event.registry.ts`.
`AuditEventPublisher` and `NotificationEventPublisher` replace the write-side
cross-context calls in identity-access, pipelines, projects, and runtime.
`OutboxRelayService` and `GithubSyncOutboxHandler` register all four owned
topics with one dispatcher, and `scripts/process-outbox.cjs` runs the one
compiled relay. PostgreSQL `pg_try_advisory_lock` gives the outbox one owner
across processes; failed handlers remain pending for retry. Hierarchy grant
and revoke state mutations, sync rows, and queue rows are transactionally
coupled; audit/notification writes remain explicitly best-effort post-commit
observability. Delivery is at-least-once, so handlers must be idempotent if a
process dies after handling and before the published update. Registry, relay,
lock-behaviour, and transaction-boundary tests are included.

---

## Continuous regression safety net

Runs continuously alongside Tasks 5–10; it is a safety net, not a numbered
microservice or extraction task.

- [x] **Contract snapshots (post-change reference).** Exact-shape workflow
  metadata/YAML and provider discovery snapshots live in
  `tests/architecture/__snapshots__/`. A pre-Task-5 snapshot was not captured,
  so these protect the current contract from future drift but do not prove
  retroactive equality with the old tree.

- [x] **Route inventory.** Generate the full route table after consolidation
  and store it as the post-consolidation reference. The pre-consolidation route
  baseline was recovered from source commit `b175938` and matches the current
  145-route inventory byte-for-byte; `github-webhook.controller.ts` remains
  covered by the current inventory test.

- [x] **Boot smoke.** The architecture suite boots the full `AppModule`
  application context and a real HTTP/Express application. The no-database
  harness accepts the documented 503 readiness envelope; the conditional
  Postgres integration suite runs when `SUPABASE_DB_URL` is present.

- [x] **Rollback evidence.** The remediation starts from checkpoint commit
  `5b703e9` on the named trunk and ends as a normal revertible commit; no
  reset, force-push, branch deletion, or worktree cleanup is required. PR
  independence remains a review/process rule rather than something a local
  repository test can prove.

**Status (2026-08-28):** current contract snapshots, the route reference and
hash manifest, the recovered pre-consolidation route comparison, the full
application-context boot, and the real HTTP boot harness are in the repository.
The source commit did not contain a pre-consolidation contract snapshot, so
that comparison remains unavailable. Rollback is evidenced procedurally by
the checkpoint plus a normal revertible commit; PR-level independence still
requires the normal review process.

See `docs/architecture/REMEDIATION_EVIDENCE.md` for the executed commands,
measured coupling, environment-dependent checks, and final commit evidence.

---

## Sequence, effort, and the recommended stopping point

| Task | Est. | Nature | Value if you stop here |
|---|---|---|---|
| 0 — baseline | 0.5–1 d | environment | nothing works without it |
| 1 — CI gate | 0.5 d | config | refactor becomes defensible |
| 2 — port 2 gates | 1–2 d | copy + adapt | violations become visible |
| 3 — move-proof imports | 3–5 d | mechanical | **saves ~2 weeks in Task 8** |
| 4 — rules + guards + config | 2–3 d | config | regressions become impossible |
| 5 — provider containment | 1 wk | design + SQL | providers become a real plugin |
| 6 — break cycles | 3–5 d | surgical | context cycles are removed; runtime remains an extraction candidate |
| 7 — contracts + ports | 1–1.5 wk | design | **the actual decoupling** |
| 8 — consolidation | 1.5–2 wk (+0.5 d/PR test debt) | mechanical | 6 folders, smaller mental model |
| 9 — schema ownership | 1–2 wk | tedious | inline SQL gets a boundary |
| 10 — async sinks | 1–2 wk | behavioural | `platform-ops` fully decoupled |
| regression net (parallel) | ~2 d spread over 5–10 | discipline | catches what gates miss |

**Tasks 0–8: ~5–6.5 weeks. Through Task 10: ~8–10.5 weeks.**

Estimates assume one focused developer with agent assistance on the mechanical
tasks (3, 8). They are estimates, not measurements.

### Recommended stop: after Task 7

**~3.5–4.5 weeks, zero files moved.** That buys:

- every cross-context call behind a contract, and a port where it matters
- both extraction-blocking cycles gone
- provider identity contained in `runtime`
- five gates preventing regression

You would still have 17 folders. Extractability is a property of the **seam**,
not the folder count, but a seam is not sufficient by itself: the current
runtime graph and compatibility dependencies still need to be reduced before
an out-of-process binding is a configuration-only change. Task 8 buys tidiness
and a smaller mental model; it does not activate extraction.

Given that module consolidation has already been deferred once on exactly this
reasoning, taking the value in Tasks 0–7 and deferring 8 is the honest split.

## What we deliberately do not take from alphaci-be

| Rejected | Why |
|---|---|
| Turborepo, `apps/` + `libs/` | one deployable; `FUTURE_STATE.md` records the rejection |
| `edge-gateway` | nothing to route between |
| Internal JWT / `x-internal-token` | no network hop to authenticate |
| Per-service DB roles + `search_path` | revisit only if cross-schema leakage is demonstrated |
| HTTP port adapters | in-process bindings; revisit only if a future extraction trigger is approved |
| Pub/Sub + DLQ + inbox | in-process dispatch has no redelivery |
| `public-api/` naming | we use `contracts/`, matching the context map |
| `check-module-boundaries.cjs` | dependency-cruiser already does this better |

The sibling repo's own spec says per-service roles exist so "a later split is a
config change, not a rewrite" — and then explicitly defers the split. Same
posture applies here, one level earlier.

## Open decisions carried from the design doc

1. `deployments` → `runtime` rename in Task 8.1, or keep the name?
2. `hierarchy` (7,146 lines) inside `identity-access`, or a seventh context?
3. Does `billing` ship in enterprise installs? If not, its ports must tolerate
   absence.
4. Does `capabilities` belong in `identity-access` or `platform-ops`?
5. Task 9 before or after Task 8? Before is safer; after is faster.
6. Do the two provider registries and the two `DeploymentProvider` interfaces
   converge? (Out of scope here.)
7. ~~Does `gcp` join the `env_provisioning` tables?~~ **Answered:** the sibling
   repo keeps both schema families under one `runtime` owner. Task 9 adopts
   that.

## Related documents

- `docs/architecture/MODULE_CONSOLIDATION_PLAN.md` — current vs future state, full trees
- `docs/architecture/FUTURE_STATE.md` — records the rejection of split services
- `docs/architecture/DDD_CONTEXT_MAP.md` — bounded contexts and ubiquitous language
- `docs/modular-architecture-deployments.md` — provider plugin architecture (axis 2)
- `alphaci-be/docs/architecture/hexagonal-hybrid.md` — the sibling microservice spec
