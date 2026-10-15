# On-prem host enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and enroll a reusable workspace machine with protected credentials and factual connection status.

**Architecture:** Runtime owns machine records, short-lived enrollment, authentication, and heartbeat. Installers configure the existing Windows/WSL and Ubuntu host tools. A workspace Hosts screen consumes the new APIs; environment bindings follow in the next plan.

**Tech Stack:** NestJS, PostgreSQL, TypeScript, Bash/systemd, PowerShell/WSL, Next.js, Jest.

**Spec:** [Approved design](../specs/2026-10-15-onprem-host-onboarding-design.md). Depends on [project repairs](2026-10-15-onprem-project-repairs.md).

**Execution status, 2026-10-15:** API/schema, supervisor, installers, Hosts UI, and focused tests are implemented. Disposable PostgreSQL enrollment races and installer recording tests pass. The signed-in Enterprise Hosts page loads for the project workspace. A real Ubuntu/systemd installation, Windows prerequisite phases, reboot recovery, and unattended startup remain unverified. Unchecked acceptance steps below retain their full original scope. See [execution evidence](../../operations/onprem-local-acceptance.md).

## Global Constraints

- "Codes expire after 10 minutes and contain 256 bits of cryptographic randomness."
- "Databases store hashes."
- "Heartbeats run every 30 seconds; a host with no check-in for 90 seconds appears offline."
- "Host enrollment distributes public trust material only."
- "Existing Docker installations/configuration must not be overwritten automatically."
- "Start the polling timer after configuration is complete rather than starting an agent that repeatedly fails until manual edits are finished."

## Review Focus

- Two concurrent code consumers must yield exactly one credential. Task 1 uses a database race test.
- A lost enrollment response must not allow credential replay. Task 1 tests consumption retries and explicit rotation.
- A project viewer must not become a host manager. Task 1 tests workspace and application-role denial.
- An interrupted Windows installation must resume without another enrollment. Task 2 tests persisted installation state and startup.
- An installer or support bundle must not disclose credentials. Task 2 tests redaction and file permissions.

---

### Task 1: Add machine inventory, enrollment, and heartbeat APIs

**Files:** Create `supabase/migrations/runtime/20261015020000_onprem_machines.sql`; `src/modules/runtime/application/onprem/onprem-host.contracts.ts`; `onprem-hosts.service.ts` and spec in that directory; `src/modules/runtime/infrastructure/repositories/onprem-machines.repository.ts`; `src/modules/runtime/api/onprem-hosts.controller.ts` and spec. Modify Runtime wiring. Create `tests/e2e/onprem-enrollment.e2e-spec.ts`.

**Interfaces:** Define `MachineSummary { id: string; workspaceId: string; name: string; platform: 'windows' | 'ubuntu'; agentVersion: string | null; lastSeenAt: string | null; status: 'enrollment_pending' | 'connected' | 'prerequisites_failed' | 'offline' | 'revoked'; checks: ReadinessCheck[] }`. Pending summaries refer to enrollment IDs until consumed. Define `InstallerRelease { version: string; url: string; sha256: string }`, `EnrollmentReceipt { id: string; code: string; expiresAt: string; installer: InstallerRelease }`, and `EnrollmentResult { machine: MachineSummary; credential: string; apiUrl: string; trustKeys: Record<string, string> }`.

`OnpremHostsService` produces `list(workspaceId, userId): Promise<MachineSummary[]>`, `createEnrollment(workspaceId, userId, {name, platform, requestId, replacesMachineId?}): Promise<EnrollmentReceipt>`, `consumeEnrollment(code, {agentVersion, checks}): Promise<EnrollmentResult>`, `heartbeat(credential, {agentVersion, checks}): Promise<void>`, and `revoke(workspaceId, machineId, userId): Promise<void>`. All IDs are strings; checks use Task 2 of the repairs plan. Operator endpoints are `GET /workspaces/:workspaceId/onprem-hosts`, `POST /workspaces/:workspaceId/onprem-host-enrollments`, and `POST /workspaces/:workspaceId/onprem-hosts/:machineId/revoke`. Agent endpoints are `POST /onprem/enroll` and `POST /onprem/heartbeat`.

- [ ] Write failing unit and disposable-database tests: `concurrentConsumeReturnsOneCredential`, `expiredAfterTenMinutes`, `lostResponseCannotReplayCredential`, `rotationRequiresExplicitMachine`, `viewerCannotEnroll`, `otherWorkspaceCannotManage`, `revokedHeartbeatDenied`, and `offlineAfterNinetySeconds`. Assert `expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)` for parallel consumption, a 32-byte random code, stored hashes only, no secret in errors, and request-ID retry never creates a second machine or silently replaces one. A consumed/repeated enrollment returns an actionable conflict rather than replaying plaintext.
- [ ] Run `npx jest --runInBand --testPathPattern='onprem-hosts'`; confirm tests fail for missing implementations. Run the new E2E through the existing Enterprise harness against disposable PostgreSQL.
- [ ] Implement Runtime-owned `onprem_machines` and `onprem_enrollments`, restricted database access, transactional consumption and explicit rotation, rate limits, and distinct `onprem_machine_` credentials. Use existing workspace access, app-role lookup/`canManageHosting`, and cleanup ports rather than querying Identity tables directly. Reads allow workspace visibility; enrollment/revoke requires the existing management policy plus non-viewer membership. Serialize revocation and heartbeat on the machine row. Compute offline state from the server clock; connected does not imply application health. Existing legacy host APIs remain unchanged.
- [ ] Run focused tests, real database race/rollback tests, and backend architecture/type checks. Verify revoked credentials stay revoked after migration rollback/reapply and no startup code applies SQL.
- [ ] Commit as `feat(runtime): enroll workspace onprem machines`, including canonical API/schema documentation and changelog required by repository rules.

### Task 2: Install a machine supervisor safely on Ubuntu and Windows

**Files:** Modify `deploy/onprem/agent/install.sh`, `alphaci-agent.service`, and `alphaci-agent.timer`; create `deploy/onprem/agent/alphaci-supervisor.sh` and `enroll.sh`. Modify `deploy/onprem/windows/Install-AlphaCIHost.ps1` and its existing startup/support/uninstall helpers. Create `deploy/onprem/agent/release-manifest.json`, `scripts/package-onprem-agent.mjs`, and `tests/e2e/onprem-installer.e2e-spec.ts`. Extend the local acceptance runbook.

**Interfaces:** `enroll.sh` consumes `POST /onprem/enroll` from Task 1, reads the code interactively, and atomically writes `/opt/alphaci/secrets/machine-token`, public trust, and `/opt/alphaci/machine.json` with root-only secret permissions. `alphaci-supervisor.sh --once` consumes that configuration and posts heartbeat every timer cycle. Stage 2 only heartbeats; Stage 3 adds assignment work. The machine timer invokes the supervisor every 30 seconds. Preserve the legacy environment-agent installation path.

- [ ] Add failing installer tests asserting checksum mismatch prevents execution, missing trust/config prevents timer enablement, a repeated install reuses the credential without consuming a code, failed enrollment leaves no partial credential, and support export contains no token/code/private key. Assert `expect(enrollmentRequestsAfterReinstall).toBe(0)`. Test mocked Windows phases `prerequisites`, `restart_required`, `enrollment`, and `startup`, with the same installation identity after resume.
- [ ] Run `tests/e2e/onprem-installer.e2e-spec.ts` through the Enterprise E2E harness and the packaging script's tests; expect missing behavior to fail.
- [ ] Implement a controlled versioned archive and checksum manifest, with installer-pinned downloads and a preview artifact before any release publication. Check Ubuntu/systemd, Docker/Compose, curl/jq/openssl, flock, CA trust, disk, and API access. Reuse existing Docker configuration. On Windows check virtualization, WSL, distro and owning account, record resumable non-secret state, and reuse port forwarding/startup scripts. Explain elevation/reboot/subnet/registry steps. Enable the service only after protected config and an authenticated heartbeat succeed. No inbound administration endpoint is installed.
- [ ] Verify clean and repeated installation in a disposable Ubuntu host. Verify PowerShell prerequisites and restart recovery on the actual Windows/WSL test host, then separately verify system startup without an interactive WSL session. If a platform cannot be exercised, record the exact unverified condition and do not mark that acceptance complete. Confirm credentials are absent from process arguments, shell history, and diagnostics.
- [ ] Commit as `feat(onprem): install and resume enrolled machine agent`. Publishing a downloadable release remains a separate reviewable action.

### Task 3: Expose workspace Hosts and enrollment progress

**Files:** In the frontend repo create `src/features/hosts/model/host-types.ts`, `data/hosts-api.ts`, `view-models/use-hosts-view-model.ts`, `views/hosts-page.tsx`, and `index.ts`; add `src/app/(platform)/hosts/page.tsx`. Modify `src/features/workspace/selection/views/app-nav.tsx` and its nav model/view-model as needed. Tests sit beside the new data/view-model/view files.

**Interfaces:** `hosts-api.ts` exposes `listHosts(workspaceId)`, `createHostEnrollment(workspaceId, {name, platform, requestId, replacesMachineId?})`, and `revokeHost(workspaceId, machineId)`, using Task 1 payloads. Feature-local types mirror the API. Do not put credential values into shared navigation state, URLs, browser storage, or analytics.

- [ ] Write failing tests for pending-to-connected enrollment, expiry, offline/prerequisite failure, workspace switching, viewer controls, duplicate-click prevention, and explicit replacement confirmation. Assert `expect(screen.queryByText('Application healthy')).not.toBeInTheDocument()` for a connected machine without deployment evidence. A check-in older than 90 seconds must display offline.
- [ ] Run `npm test -- --runInBand --testPathPattern='features/hosts'`; confirm the new behavior fails first.
- [ ] Implement a thin route, workspace-scoped API/view-model, one-time code display, installer instructions, last seen/version/checks, and revoke action with its offline-container limitation. Keep Add host distinct from environment assignment. Cancel stale workspace requests and stop refresh on unmount.
- [ ] Run focused tests, frontend lint/typecheck, then verify normal Enterprise sign-in can enroll and observe the test machine. Preserve preexisting frontend changes and commit only this feature as `feat(hosts): add workspace enrollment screen`.
