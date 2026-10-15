# Existing on-prem project repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair `eatta` history and CI connectivity without waiting for machine enrollment.

**Architecture:** Runtime provider packs contribute a history source alongside their other capabilities. Readiness separates schema, API connectivity, signing, and host evidence. Reuse the existing workflow preview/update path.

**Tech Stack:** NestJS, TypeScript, PostgreSQL, Jest, GitHub Actions, HTTPS tunnel.

**Spec:** [Approved design](../specs/2026-10-15-onprem-host-onboarding-design.md).

**Execution status, 2026-10-15:** History, readiness, URL preflight, and persisted environment regeneration are implemented and tested. Targeted remote schema changes, Enterprise restart, HTTPS health/installer probes, and a read-only eatta workflow preview are complete. Workflow/secret publication and actual runner/release acceptance remain open. Unchecked acceptance steps below retain their full original scope. See [execution evidence](../../operations/onprem-local-acceptance.md).

## Global Constraints

- "Remote Supabase remains in use."
- "The frontend and backend run the Enterprise edition with normal GitHub sign-in and Quick Login disabled."
- "An empty on-prem registry is a successful empty result, not mock mode."
- "Do not apply database migrations on a browser GET, app startup, or project-creation request."
- "Private signing keys remain in the configured CI secret or KMS signer."
- No provider-specific branch in Projects and no empty on-prem cloud client.

## Review Focus

- A target without an environment must not reveal another target's history. Task 1 tests strict association.
- A database outage must report unavailable history. Task 1 tests rejected queries.
- Mixed cloud/on-prem targets must retain cloud authentication. Task 1 tests both sources together.
- IPv6 loopback and private URLs must not slip through public-runner validation. Task 2 tests URL variants.
- GitHub secret inspection denied by permissions must remain unverified. Task 2 tests that result.

---

### Task 1: Read host-delivered deployment history

**Files:** Modify `src/modules/runtime/core/provider-pack.ts`, `src/modules/runtime/runtime.module.ts`, `src/modules/runtime/application/project-deployments.service.ts`, `src/modules/runtime/infrastructure/providers/onprem/onprem-compose-provider.pack.ts`, and `src/modules/runtime/infrastructure/repositories/release-registry.repository.ts`. Create `src/modules/runtime/application/ports/deployment-history-source.port.ts`, `src/modules/runtime/core/deployment-history-source.registry.ts`, and `src/modules/runtime/infrastructure/providers/onprem/onprem-deployment-history.source.ts`. Tests live beside those files; extend `src/modules/projects/application/dashboard/project-previews.query-service.spec.ts`.

**Interfaces:** Define `DeploymentHistorySource { provider: string; read(target: DeploymentTargetSummary, userId: string): Promise<DeploymentHistoryItem[]> }`. Add optional `historySource` to `RuntimeProviderPack`, validating its provider identity. Produce a composed `DeploymentHistorySourceRegistry.find(provider: string): DeploymentHistorySource | undefined`. Existing cloud client lookup is the fallback for providers without this contribution. The on-prem source consumes `ReleaseRegistryRepository.listTargetDeploymentHistory(projectId: string, targetId: string): Promise<DeploymentHistoryItem[]>`; it joins the target's persisted environment, deployment `target_ids`, and immutable release identity. Keep environment association inside Runtime rather than inventing a Projects dependency.

- [x] Write failing tests for `emptyRegistryIsLive`, `historyIsScopedToTargetAndEnvironment`, `unboundTargetHasNoHistory`, `databaseFailureIsUnavailable`, `mixedSourcesPreserveCloudCredentials`, and `previewConsumesRegistryHistory`. Assert `expect(result).toMatchObject({mode: 'live', deployments: []})` for an empty registry, and no mock entries on failure.
- [x] Run `npx jest --runInBand --runTestsByPath src/modules/runtime/application/project-deployments.service.spec.ts src/modules/projects/application/dashboard/project-previews.query-service.spec.ts`; confirm the missing history route fails.
- [x] Implement the contract, registry, composition, query, and mapping. Preserve history ordering, commit SHA, timestamps, and URLs. Map queued to queued, deploying to building, healthy to ready, and failed/rolled_back to failed. A rolled-back failed attempt must not become a successful deployment. Missing optional cloud clients must enter the existing error handling rather than throw outside it.
- [x] Add a disposable-database query test in `tests/e2e/onprem-history.e2e-spec.ts` with another project, environment, and target as exclusion fixtures. Run it with the Enterprise E2E harness and run the focused unit tests; expect all assertions to pass.
- [x] Commit this deliverable as `fix(runtime): read onprem history from release registry`, staging only its source, tests, and required contract documentation.

### Task 2: Validate deployment prerequisites without mutating setup

**Files:** Create `src/modules/runtime/application/onprem/onprem-readiness.service.ts`, `src/modules/runtime/api/onprem-readiness.controller.ts`, and their specs. Modify `src/modules/projects/application/workflows/staged-workflow.builder.ts` and its specs. Create `src/modules/projects/application/workflows/ci-api-connectivity.ts` and its spec. Extend `tests/e2e/onprem-host-migration.e2e-spec.ts` and Runtime module wiring.

**Interfaces:** Produce `OnpremReadinessService.read(projectId: string, environmentId: string, userId: string): Promise<OnpremReadiness>`, exposed as `GET /projects/:projectId/environments/:environmentId/onprem-readiness`. Define `ReadinessCheck { id: string; status: 'passed' | 'failed' | 'unverified'; message: string }` and `OnpremReadiness { checks: ReadinessCheck[] }`. Reuse these types in later plans. Produce `validateCiApiConnectivity(baseUrl: string, execution: 'github-hosted' | 'private-network'): void`. Default to github-hosted; private-network requires an explicit operator configuration that actually selects a reachable execution environment. This task does not add a new runner implementation.

- [ ] Write failing tests asserting missing `env_provisioning.onprem_hosts_one_active_per_environment` is reported even when the migration ledger says applied, reads issue no DDL, and inaccessible signing-secret inspection yields unverified. Assert `expect(secretCheck.status).toBe('unverified')`. Reject localhost, 127/8, `::1`, link-local, private ranges, URL credentials, and non-HTTPS public-runner URLs. Cover explicit private-network validation separately without claiming runner reachability.
- [ ] Run `npx jest --runInBand --testPathPattern='onprem-readiness|ci-api-connectivity|staged-workflow.builder'`; expect the new checks to fail before implementation.
- [ ] Implement schema-object inspection and separate readiness checks using project visibility and existing host-management authorization where management details are exposed. Derive generated CI endpoints from `PLATFORM_PUBLIC_URL`; preserve local OAuth callbacks. Keep network tests bounded and distinguish server configuration from actual runner evidence. Extend migration tests for duplicate cleanup, replay, concurrent registration, and rollback.
- [ ] Run the focused tests and `tests/e2e/onprem-host-migration.e2e-spec.ts` against disposable PostgreSQL; expect no duplicate active hosts and verified rollback behavior.
- [ ] Commit as `feat(runtime): report onprem deployment prerequisites`.

### Task 3: Restore the current test project's CI path

**Files:** Create `docs/operations/onprem-local-acceptance.md`. Use ignored local configuration only for tunnel/signing setup. Reuse `ProjectWorkflowsService.previewWorkflowSettings` and `createWorkflowUpdatePullRequest`, exposed by the existing `/projects/:id/workflow-settings/preview` and `/pr` routes.

**Interfaces:** Consume `OnpremReadinessService.read` from Task 2. Record evidence by code revision, schema object, tunnel URL, workflow revision, CI run URL, release ID, and signature verification result. Never include secret values.

- [ ] Run backend lint, typecheck, unit/architecture tests, and documentation checks before changing the running test setup; record failures separately.
- [ ] Apply only the reviewed `supabase/migrations/runtime/20261015010000_one_active_onprem_host.sql` with `npm run db:apply -- runtime/20261015010000_one_active_onprem_host.sql`. The script resolves arguments beneath `supabase/migrations`. Verify the actual remote index and duplicate count afterward. Do not run all pending migrations.
- [ ] Start a temporary HTTPS tunnel to port 4000, set the ignored backend `PLATFORM_PUBLIC_URL`, and restart Enterprise with Quick Login disabled. Preserve localhost OAuth callback and return URL. Configure matching backend public trust and the existing CI signer secret without exposing private material. Mark permission-limited secret checks unverified.
- [ ] Preview regenerated `eatta` workflows through the existing service and inspect every generated API endpoint. Present the concrete workflow update for publication review if needed; no automatic PR merge follows plan approval. Record tunnel URL expiry/change recovery instructions.
- [ ] From the actual authorized GitHub workflow run, verify authorization, result reporting, frontend image publication, release registration, and accepted signature. A laptop HTTP probe or skipped job does not satisfy these checks. Record unresolved external permissions explicitly.
- [ ] Run `npm run check:documentation` and `git diff --check`, then commit the evidence/runbook as `docs(onprem): record local project acceptance`. This stage may finish before any new machine is enrolled; do not claim application deployment yet.
