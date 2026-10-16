---
type: "Report"
title: "Local on-prem acceptance"
description: "Verified local host onboarding evidence and remaining operator acceptance checks for 2026-10-15."
tags: [runtime, on-prem, testing]
status: draft
sources:
  - id: host-setup
    resource: "/runbooks/runbook-onprem-host-setup.md"
    title: "Host setup and operations"
  - id: onprem-tests
    resource: "tests/e2e"
    title: "Disposable database and Docker acceptance tests"
---

# Local on-prem acceptance, 2026-10-15

The implementation is available locally on `codex/onprem-host-onboarding` in the backend and frontend repositories. This record separates exercised behavior from remaining operator acceptance. It is not a production deployment report.

## Running test setup

- Frontend: `http://localhost:3000`, Enterprise, normal GitHub session, Quick Login disabled.
- Backend: `http://localhost:4000`, Enterprise, remote Supabase session pooler with pinned CA verification.
- Workspace: Team Blaine, `de7bf7bf-f87c-4d4a-a66b-77a721e5eb42`.
- Project: `Alphaexplora-Sandbox/eatta`, `847b8983-c500-4705-ba10-e38477e9679a`.
- Temporary API: `https://teacher-entertaining-animated-manufacturer.trycloudflare.com`.
- Local OAuth callback and frontend return URL remain on localhost.

The tunnel must remain running during this test. When its address changes, update the ignored backend `PLATFORM_PUBLIC_URL` and `ONPREM_INSTALLER_URL`, restart the backend, regenerate the workflow preview, update the CI report URL, and explicitly replace/re-enroll any machine configured for the previous API. Do not silently point an existing credential at a different deployment.

The ignored `.env.local` contains public trust and installer configuration. Test signing private material is under the ignored `.tmp/onprem/secrets/` directory with Windows ACLs restricted to the current account. No private key, enrollment code, machine token, or CI token belongs in this document or Git.

## Verified evidence

| Check | Result and limit |
| --- | --- |
| Backend unit gate | 303 suites passed, 4 skipped; 4,029 tests passed, 53 skipped; two snapshots passed. Includes three machine-readiness cases. |
| Frontend unit gate | 272 suites and 3,688 tests passed before the final provider gate change; its API/nav regression recheck passed 10 tests afterward. |
| Lint and type checking | Both repositories pass; frontend lint reports four existing warnings. |
| Architecture | Schema ownership and application boundary checks pass. Documentation maps and route inventory include the new endpoints. |
| Enrollment database tests | Four disposable PostgreSQL scenarios cover one-use consumption, replay/expiry, explicit replacement/revocation, and workspace cleanup. |
| Assignment database tests | Five disposable PostgreSQL scenarios cover compare-and-set, idempotency, legacy exclusivity, ports, scoped authorization, revoke/status serialization, and rollback/reapply. |
| Installer/supervisor fixtures | Six tests pass for enrollment recovery, protected files, API mismatch refusal, assignment locking/removal, and failed health/occupied-port status. These use recording fixtures. |
| Legacy agent regression | Seven scenarios pass with the recording fixture. |
| Real Docker multi-project test | Two frontend HTTP applications deploy concurrently with pinned digests and verified signatures. A failing A update rolls back to its healthy release. B retains its container ID, volume sentinel, release state, port, and HTTP 200 response. |
| Docker test limits | The API is a recording fixture. Worker health requests use `host.docker.internal` to cross the test container namespace. This does not prove a real Windows install, GitHub runner, registry credentials, or external ingress. |
| Live browser | Existing normal-sign-in session loads Hosts for Team Blaine and all three eatta assignment forms. Test prerequisites show schema/API URL/signing trust passed, no host assigned, and runner/registry/signing-secret checks unverified. Empty history renders as not deployed. |
| Public HTTPS | `/api/v1/health` returns HTTP 200 through the tunnel. Installer bytes download through the public route and match the expected SHA-256. This is a laptop probe, not runner evidence. |

Local logs and preview files are under ignored `artifacts/onprem/`. The real-container result is `host-multiproject-e2e.log`; the final backend gate is `backend-unit-final.log`.

## Applied remote schema

Only these reviewed runtime migrations were applied with `npm run db:apply -- <paths>`:

1. `runtime/20261015010000_one_active_onprem_host.sql`
2. `runtime/20261015020000_onprem_machines.sql`
3. `runtime/20261015030000_onprem_machine_assignments.sql`

Before application there were zero active registrations and zero duplicate active environment bindings. Direct PostgreSQL inspection afterward confirms the enrollment, machine, workspace lifecycle, and port reservation tables exist with RLS enabled and no anon/authenticated SELECT grant. The active-environment unique index is valid and unique. Startup and browser GETs do not apply migrations.

## Installer and workflow artifacts

- Installer version: `0.1.0`.
- Archive: `artifacts/onprem/alphaci-agent-0.1.0.tar.gz`.
- SHA-256: `8eb6ad4027f8693d9f806828fc75b1d9984868afe0b4d6f106d6ea80b7148e1a`.
- Public download: the temporary API plus `/api/v1/onprem/installer/0.1.0`.
- Verification key ID: `sha256:50baced1aee8007e0913900d5b2ad6b8b5296da62ea1a6353d0d32037aca29ce`.

A read-only transaction loaded persisted project settings, environments, and targets, then called `ProjectWorkflowsService.previewWorkflowSettings`. Five generated files are saved in `artifacts/onprem/eatta-workflow-preview/` with no validation warnings. They retain Test `dev`, UAT `uat`, and Production `main`; only Test automatically builds/registers the frontend release. Generated validation, release registration, and signing endpoints use the temporary HTTPS API. Result reporting still uses the repository `ALPHACI_REPORT_URL` secret and must be updated there.

The current CLI identity has pull access without push/admin rights. The app could not obtain a usable linked installation token for this project during the read-only access check. No workflow PR, merge, or CI secret write was performed. Normal browser OAuth permissions may differ and have not been proven to permit publication.

## Personal test sequence and open acceptance

1. Open `http://localhost:3000/hosts?workspace=de7bf7bf-f87c-4d4a-a66b-77a721e5eb42`. Add the real Windows/WSL or Ubuntu host. Use the displayed checksum-verified installer command and enter the short-lived code interactively. Codes are not command arguments.
2. Complete the host prerequisites described in [host setup](../runbooks/runbook-onprem-host-setup.md). Verify its authenticated heartbeat, Docker/Compose checks, agent version, and connected state. A connected machine does not establish application health.
3. On eatta Hosting, assign Test to the machine with a free host port, container port 3000, and a working application health path such as `/`. Use separate host ports for UAT, Production, and other projects. Production requires an HTTPS address: existing HTTPS ingress, or the automatic HTTPS address (tunnel).
4. With repository write and Actions-secret permission, publish the reviewed workflow update through a PR. Configure `ALPHACI_REPORT_URL` for this tunnel and a CI signing secret matching the pinned public trust. Verify the existing `ALPHACI_TOKEN` through the actual access workflow. Do not print or place secrets in a PR.
5. Run the actual GitHub pipeline. Record its run URL, image digest, release ID, accepted signature, host deployment status, and working application URL here. None has been established yet for eatta.
6. Promote that healthy release to UAT and then Production using the existing manual gates. Record the same release ID and actual application health for each destination.
7. Repeat with a second project on the same machine. Confirm a failing update to one project does not change the other's container, volume data, release state, or URL.
8. Restart the agent, then reboot the actual Windows host. Separately verify unattended startup without an interactive WSL session, networking/firewall rules, reconnected heartbeat, and no duplicate work. PowerShell parsing passed; these runtime checks remain unverified.

Installer release publication and product-source PR publication/merge are separate review actions. Existing containers and data survive unassignment or revocation; neither action cancels a Docker command already executing. Use separate machines for mutually untrusted workloads.
