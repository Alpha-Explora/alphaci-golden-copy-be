# Consolidation Baseline — Task 0 record

**Recorded:** 2026-08-26, worktree `merry-prism/alphaci-enterprise-be`, HEAD
`b175938` (main).

## Environment notes (deviations from stock `npm ci`)

- No system `npm` on this machine; used the Codex bundled runtime:
  `node.exe` v24.19.0 + `pnpm.cmd` 11.19.0 from the codex-primary-runtime
  dependencies folder.
- `pnpm import` was run once to translate `package-lock.json` →
  `pnpm-lock.yaml` plus a `pnpm-workspace.yaml` build-scripts stub (both untracked, **do not commit without discussion**) so
  `pnpm install --frozen-lockfile` could reproduce the npm lockfile.
- pnpm blocked two build scripts (`@nestjs/core` postinstall, `@scarf/scarf`
  telemetry). Neither affects tests; left unapproved.
- Sandbox blocks reads inside `node_modules/.pnpm`; gates must run with the
  elevated exec profile on this machine.

## Gate results at HEAD `b175938`

| Gate | Result | Notes |
|---|---|---|
| typecheck (`tsc --noEmit`) | PASS | exit 0, zero errors |
| test (jest --ci) | PASS | **114 suites, 1206 tests**, ~51 s |
| boundaries (depcruise) | PASS | 312 modules, 1260 deps, 0 violations |
| lint (eslint flat config) | FAIL | **434 errors across 70 files** — see breakdown |

## Lint failure decomposition (434 total)

| Category | Count | Nature |
|---|---:|---|
| Prettier CRLF artifacts | ~167 | `core.autocrlf=true` converted LF to CRLF on checkout; prettier default `endOfLine: lf`. **CI on Linux sees LF and passes.** Environmental only. |
| Prettier real formatting drift | ~235 | genuine style issues committed to the repo; auto-fixable |
| `@typescript-eslint/no-unused-vars` | 22 | mostly dead imports in `projects.service.ts` left over from the decomposition PRs |
| `require-await` | 6 | async methods without await (stubs/adapters) |
| other type-aware rules | 5 | unsafe args in provider-contract suite, prefer-as-const, restrict-template-expressions |

Key insight: **lint was never a CI gate here** (the only workflow is
`boundaries.yml`). The lint debt is pre-existing and was invisible until now.

## Implications for the plan

1. **Task 1** validated: adding lint to CI naively fails on day one. Add lint
   as non-blocking first, or fix the ~235 real prettier errors + 22 unused
   imports as Task 1 Step 2, then make it blocking.
2. The 22 unused-import hits in `projects.service.ts` confirm dead code left
   by the god-file decomposition; cleanup belongs in Task 8.2.
3. The CRLF situation means every Windows checkout shows phantom lint
   failures. A one-line fix in Task 1: add `.gitattributes` with
   `*.ts text eol=lf`, or set `endOfLine: 'auto'` in `.prettierrc`.

## Post-triage state (same day, Task 1 Step 2)

Applied `.prettierrc` `endOfLine: 'auto'`, added `.gitattributes` for LF
normalization, ran ESLint auto-fix across `src` and `tests`, removed the dead
imports/parameters reported by ESLint, and fixed the remaining type-aware lint
errors. Added `.github/workflows/ci.yml` with dispatch and push-to-main
triggers.

| Gate | Result after triage |
|---|---|
| typecheck | PASS — exit 0 |
| test | PASS — 114 suites / 1206 tests |
| boundaries | PASS — 312 modules, 1258 dependencies, 0 violations |
| lint | **PASS — 0 errors** |

## Task 2 architecture-gate baseline

The new application-boundary gate reported six violations before Task 3:
five `deployments/application/*service.ts` imports of the concrete provider
registry, plus
`src/modules/deployments/application/project-sync-findings.repository.ts`,
which is a repository placed in the application layer. The metrics reporter
recorded the following per-module starting state:

| Module | Domain | Application | Ports | Infra imports | Forbidden | Cross-module | Tests |
|---|---:|---:|---:|---:|---:|---:|---:|
| admin | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| audit | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| auth | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| capabilities | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| catalog | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| ci | 0 | 0 | 0 | 0 | 0 | 0 | 5 |
| deployments | 2 | 15 | 0 | 18 | 6 | 14 | 40 |
| existing-repos | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| feedback | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| github | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| hierarchy | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| notifications | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| projects | 0 | 16 | 0 | 0 | 0 | 22 | 15 |
| subscription | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| usage | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| workflows | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| workspaces | 0 | 0 | 0 | 0 | 0 | 0 | 4 |

Totals: 2 domain files, 33 application files, 18 infrastructure imports, 6
forbidden infrastructure/repository placements, 36 cross-module imports, and
93 test files. The `forbidden` count includes the application-layer repository
placement; the five provider-registry imports account for the other violations
reported by the strict gate.
