# Reusable on-prem assignments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy several authorized project environments on one enrolled machine without deployment-state or port collisions.

**Architecture:** Existing environment host registrations become either legacy-token registrations or machine assignments. The supervisor authorizes each assignment independently and invokes the existing worker with isolated configuration. Hosting and project setup select machines through explicit assignment APIs.

**Tech Stack:** NestJS, PostgreSQL, Bash/systemd, Docker Compose, Next.js, Jest, disposable PostgreSQL/Docker acceptance fixtures.

**Spec:** [Approved design](../specs/2026-10-15-onprem-host-onboarding-design.md). Depends on [host enrollment](2026-10-15-onprem-host-enrollment.md).

**Execution status, 2026-10-15:** Assignment/CAS/port APIs, isolated workers, Hosting selection, and optional setup bindings are implemented. Real PostgreSQL authorization races and a real Docker two-project health failure/rollback test pass. Normal-sign-in browser checks show the assignment forms and factual prerequisites. Actual eatta workflow publication, host enrollment, Test-to-UAT-to-Production acceptance, and reboot recovery remain open. Unchecked acceptance steps below retain their full original scope. See [execution evidence](../../operations/onprem-local-acceptance.md).

## Global Constraints

- "Retain one active assignment per environment."
- "Keep worker state under `/opt/alphaci/assignments/<project-id>/<environment-id>/`."
- "Use a stable Compose project name derived from the globally unique environment UUID, such as `ac-<environment-uuid-without-dashes>`."
- "Unassignment stops the worker from accepting new work and preserves application data."
- "Revoked credentials remain revoked."
- "Logical project isolation within one Docker daemon is not a boundary for mutually untrusted customer workloads; those use separate machines."

## Review Focus

- A stale assign request must not replace a newer host. Task 1 tests compare-and-set under concurrency.
- A machine must not report status for another binding. Task 1 races revocation with status updates.
- A reserved port already occupied outside AlphaCI must fail without changing another stack. Tasks 1 and 2 test both reservation and host checks.
- A worker must not run the same environment twice after a timer overlap. Task 2 tests its local lock.
- A frontend-only project must not require an invented backend container. Task 2 tests target-driven Compose generation.

---

### Task 1: Bind environments and scope machine authorization

**Files:** Create `supabase/migrations/runtime/20261015030000_onprem_machine_assignments.sql`, `src/kernel/ports/onprem-assignment.port.ts`, `src/modules/runtime/application/onprem/onprem-assignments.service.ts` and spec, `src/modules/runtime/infrastructure/repositories/onprem-assignments.repository.ts`, and `src/modules/runtime/api/onprem-assignments.controller.ts`. Modify `release-registry.repository.ts`, `release-registry.service.ts`, `onprem-agent.controller.ts`, enrollment contracts, readiness service, and Runtime wiring. Create `tests/e2e/onprem-machine-assignments.e2e-spec.ts`.

**Interfaces:** Define `AssignmentConfig { ports: Array<{slot: 'frontend' | 'backend'; hostPort: number; containerPort: number}>; health: Array<{slot: 'frontend' | 'backend'; path: string | null}>; ingress: {mode: 'direct' | 'configured'; publicUrl: string | null} }` in the kernel port and import it into Runtime. Define `MachineAssignment { id: string; machineId: string; projectId: string; environmentId: string; revision: number; config: AssignmentConfig }` in Runtime. `OnpremAssignmentsService.assign(projectId, environmentId, userId, {machineId, expectedAssignmentId: string | null, requestId, config}): Promise<MachineAssignment>` and `unassign(projectId, environmentId, userId, expectedAssignmentId): Promise<void>` own changes. IDs and request IDs are strings. Use POST/DELETE `/projects/:projectId/environments/:environmentId/host-assignment` with an explicit expected assignment ID.

Produce `authorizeAgent(credential: string): Promise<{kind: 'legacy' | 'machine'; machineId: string | null; assignmentIds: string[]}>`, used by the existing GET assignments and POST deployment status routes. For machine credentials, assignment reads include `MachineAssignment` plus the existing signed release envelope. Recheck the live binding inside the status-write transaction; a prior authorization result is not sufficient.

- [ ] Write failing database tests for legacy/machine exclusivity, stale replacement 409, same request-ID replay without duplication, cross-workspace denial, unassigned-environment denial, forged deployment IDs, concurrent revoke/status writes, duplicate port reservation, and released ports after unassignment. Assert `expect(activeBindings).toHaveLength(1)` after a legacy/machine race and verify the old registration API still works.
- [ ] Run the new E2E file using the Enterprise disposable-database harness and focused `onprem-assignments` tests; confirm missing behavior fails.
- [ ] Add `machine_id` to `onprem_hosts`, allow legacy token columns to be null only for machine assignments, and add an exclusive credential-kind constraint. Retain the existing active-environment unique index. Add machine-scoped port reservations and assignment config/revision with transactional comparison and locks. Validate all target slots belong to the selected project/environment, ports are integers 1 through 65535, and health paths cannot escape the assigned application URL. Use machine/workspace and existing project/role access ports. Revoke/read/status/bind transactions lock in a consistent order. Unassignment preserves data and containers; destructive stack actions remain separate.
- [ ] Run race tests against real PostgreSQL plus legacy agent regression tests. Verify an accepted status write either commits before revocation or is denied afterward, never based on stale cached permission. Verify migration downgrade refuses active machine assignments and documented recovery restores explicit legacy registrations before removing dependencies.
- [ ] Commit as `feat(runtime): bind onprem machines to project environments`, with canonical contract/schema docs and changelog updates.

### Task 2: Run isolated workers for every active assignment

**Files:** Modify `deploy/onprem/agent/alphaci-supervisor.sh`, `alphaci-agent.sh`, and installer packaging. Create `deploy/onprem/agent/render-assignment.sh`, `tests/e2e/onprem-supervisor.e2e-spec.ts`, and `tests/e2e/onprem-multiproject.e2e-spec.ts`. Update `deploy/onprem/compose/compose.example.yaml` and local acceptance instructions where they would otherwise imply one global configuration.

**Interfaces:** Supervisor consumes authenticated machine assignments from Task 1. `render-assignment.sh` reads one validated assignment JSON on stdin and writes its config/Compose into `/opt/alphaci/assignments/<project-id>/<environment-id>/` atomically. Worker execution consumes `ALPHACI_AGENT_CONFIG` and the existing signed-envelope contract, uses Compose project `ac-<environment-uuid-without-dashes>`, and locks the assignment directory using flock. No per-assignment credential copy is placed into repository files; protected machine credentials remain host-local.

- [ ] Write failing tests for two concurrent assignments with distinct state/volumes/networks, a duplicate timer cycle taking only one lock, frontend-only target rendering, an externally occupied port, removed assignment stopping future work, and another project's config/secrets remaining byte-for-byte unchanged. Assert `expect(afterB.containerId).toBe(beforeB.containerId)` and `expect(afterB.volumeSentinel).toBe(beforeB.volumeSentinel)` after A rolls back. Missing health must be reported absent rather than healthy.
- [ ] Run the supervisor test through the Enterprise E2E harness; confirm missing assignment behavior fails. Use Docker recording fixtures for deterministic command assertions, but reserve live-container claims for the next step.
- [ ] Implement per-environment config, target-driven Compose services, isolated current/previous release files and logs, actual port preflight, and bounded concurrent workers. Retain signature/digest checks, registry authentication on the host, application health and rollback verification. Refresh authorization before work/status; do not claim to cancel Docker commands already executing. Use local secret references without distributing registry passwords from the server. Preserve any separately configured production ingress/proxy.
- [ ] Run the real Docker multiproject test: deploy A and B concurrently, promote independently, update A, force A's HTTP health failure, verify its restored release is healthy, and verify B's container identity, volume sentinel, port, and URL remain unchanged. Exercise port conflicts and unassignment/revocation. Restart the service and host to verify assignments resume without duplicate deployments.
- [ ] Commit as `feat(onprem): supervise isolated environment workers`. Upgrade the test agent package before enabling machine assignment in the UI.

### Task 3: Select hosts in setup and prove the user's flow

**Files:** In frontend modify `src/features/projects/detail/data/environments-api.ts`, `model/environment-operations.ts`, `view-models/use-environment-operations-view-model.ts`, `views/environment-operations-panel.tsx`, and Hosting readiness views. Modify `src/features/workflows/studio/model/create-project-payload.ts`, `view-models/use-onprem-hosting.ts`, and `views/setup-wizard-environments.tsx`. Add focused specs beside each changed owner. Backend project creation continues to use existing project/environment provisioning and calls Runtime through `src/kernel/ports/onprem-assignment.port.ts` from Task 1 for optional assignment, without importing Runtime internals into Projects.

**Interfaces:** Frontend consumes `MachineSummary`, `MachineAssignment`, `AssignmentConfig`, and `OnpremReadiness` from prior tasks. The creation payload carries optional per-environment `{machineId, requestId, config}`. The Runtime port exposes `assignProvisionedEnvironment(projectId: string, environmentId: string, userId: string, input: {machineId: string; requestId: string; config: AssignmentConfig}): Promise<{assignmentId: string}>`; place the shared config DTO with that port to avoid a kernel import of Runtime. A failed binding produces explicit setup/readiness status and a retryable existing environment rather than creating another project.

- [ ] Write failing tests for selecting one machine across several environments, Add host followed by explicit selection, cross-workspace machine exclusion, persisted editable health/ports, duplicate submit, binding failure after project creation, stale replacement conflict, and live application badges requiring deployment evidence. Assert `expect(createProjectRequests).toHaveLength(1)` after assignment retry and verify UAT/Production retain existing manual promotion rules.
- [ ] Run focused frontend tests and backend creation integration tests; expect the unsupported assignment input to fail before implementation.
- [ ] Implement thin UI/view-model changes, explicit bind/replace/unassign operations, host/version/check-in displays, and separate readiness reasons for API, schema, signing, registry, host, port, ingress, and health. Explain replacement limits. Preserve the existing legacy registration option during rollout. No page load or generic Retry may replace credentials or bindings.
- [ ] Run backend lint/typecheck/unit/architecture/documentation gates, scoped database E2E, frontend lint/typecheck/focused tests, and normal-sign-in browser acceptance. Complete `eatta` Test deployment and same-release UAT/Production promotion on the selected test host, then repeat with a second project. Record URLs, release IDs, actual health, reboot recovery, and B-preservation evidence separately from code and schema rollout.
- [ ] Commit frontend and backend changes separately. Request one final independent branch review and resolve findings. Present source diffs, targeted schema changes, installer artifact, and runtime acceptance evidence for publication review; do not automatically push or merge.
