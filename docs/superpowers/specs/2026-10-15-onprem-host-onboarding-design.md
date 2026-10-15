# On-prem host onboarding and deployment readiness

Status: proposed design for review. This document does not describe shipped behavior.

## Intended outcome

A user installs AlphaCI on a Windows or Ubuntu host once, sees it connect in the Enterprise app, and selects it for several project environments. Project creation supplies deployment configuration. Pushes deploy the first environment; promotion deploys the same signed release to subsequent environments. Routine deployments require no host-side configuration editing.

The first acceptance project is `Alphaexplora-Sandbox/eatta`, project `847b8983-c500-4705-ba10-e38477e9679a`. It has Test on `dev`, UAT on `uat`, and Production on `main`, each with a frontend on-prem target. The user selected a temporary HTTPS tunnel to the local AlphaCI API for this test. Remote Supabase remains in use. The frontend and backend run the Enterprise edition with normal GitHub sign-in and Quick Login disabled.

## Observed baseline

- Project creation persisted all three environments and their targets correctly.
- Generated workflows contain `http://localhost:4000`. GitHub-hosted jobs fail authorization with HTTP 000 before building images.
- No releases, environment deployments, or host registrations exist for this project.
- The shared Hosting history request throws `No provider client registered for: onprem-compose`. It calls the cloud provider-client registry for a host-delivered target.
- Supabase contains the release registry tables but lacks `env_provisioning.onprem_hosts_one_active_per_environment`.
- The existing agent polls assignments, verifies signatures and image digests, deploys Compose, checks health, rolls back, and reports status.
- The existing Linux installer installs one fixed `alphaci-agent.service`, timer, and `/opt/alphaci/agent.env`. The Windows installer configures WSL startup and port forwarding after Linux prerequisites already exist. Neither implements enrollment or several independently configured assignments.

## Scope and delivery order

Deliver three independently verifiable slices in order. Repairing current deployment reads must not depend on completing the host manager.

1. **Repair existing projects:** correct on-prem history reads, verify/apply the targeted outstanding migration, connect the local API through the selected tunnel, regenerate `eatta` workflows, and verify CI reaches AlphaCI. Preserve cloud-provider behavior.
2. **Host installation and enrollment:** workspace host inventory, a one-use enrollment exchange, Windows and Ubuntu installers, automatic startup, authenticated heartbeat, and explicit readiness information.
3. **Reusable assignments:** assign existing machines to project environments, manage isolated workers/configuration, integrate host selection into project setup, and verify two projects on one host.

A slice is complete only when its runtime acceptance checks pass. Writing this design or passing unit tests does not establish that `eatta` deployed successfully.

## Repair deployment history

Runtime owns on-prem deployment history. Read `env_provisioning.environment_deployments` joined to immutable release identity, artifacts, and the project's visible environments. Filter each target's history by its environment and membership in the deployment's `target_ids`. Preserve the existing response shape, commit identity, timestamps, status, ordering, and error reporting.

Route history through an explicit provider-neutral history-source contract contributed by provider composition. The on-prem source reads the release registry; hosted sources continue using their existing authenticated provider adapters. Do not add an empty on-prem cloud client merely to suppress the exception, fake history, or hardcode an edition/provider branch in Projects. An empty on-prem registry is a successful empty result, not mock mode. A database failure is unavailable history, not an empty success.

The Hosting summary and project preview readers must both consume the corrected result. Shared reads cannot expose records for another project, environment, or unauthorized viewer.

## API connectivity, schema, and signing

Use the existing `PLATFORM_PUBLIC_URL` configuration as the single externally reachable AlphaCI base URL for generated CI endpoints. Keep local browser OAuth callbacks on localhost for this test. Start the user-selected temporary tunnel to port 4000; update the backend configuration and restart before regenerating existing workflows. Do not change the frontend's local OAuth return address just to make CI reachable.

Preflight must reject a loopback/private-only CI URL when GitHub-hosted execution is selected. Private addresses remain supported when execution is explicitly configured to reach that network; never infer accessibility from the word on-prem. Test authentication from the actual CI runner. A laptop-only URL probe cannot establish runner reachability. Tunnel URL changes require updating configuration and regenerating the affected workflows.

Readiness reports migration identifiers, missing schema objects, reachable API state, signing configuration, and host readiness separately. Do not apply database migrations on a browser GET, app startup, or project-creation request. Run the targeted `20261015010000_one_active_onprem_host.sql` as an operator setup step, preserving its duplicate-token cleanup and rollback behavior. Verify the actual index afterward, not only a migration ledger.

Configure one release-signing trust setup per AlphaCI deployment. Backend verification and host verification use matching public keys; signing private keys remain in the configured CI secret or KMS signer. Host enrollment distributes public trust material only. Verify access to required repository/organization secrets without printing values; unavailable permission checks must be shown as unverified. Check registry pull access from the host before claiming an assignment is ready. A successful API connection does not establish signing or registry readiness.

## Host inventory and authorization

Separate a physical machine from an environment assignment:

- **Machine:** UUID, workspace, display name, Windows/Ubuntu platform, agent version, credential hash/prefix, creation identity/time, revocation time, last check-in, and reported prerequisite status. A machine may serve several explicitly assigned project environments within its workspace.
- **Assignment:** the existing environment host registration associated with one machine, project, and environment. Retain one active assignment per environment. The target slots remain owned by deployment targets rather than copied into machine identity.
- **Enrollment:** a hashed one-use code, workspace, creator, requested machine name/platform, expiry, consumption state, and resulting machine identity. Codes expire after 10 minutes and contain 256 bits of cryptographic randomness. Failed attempts are rate-limited and never logged with credential values.

Runtime owns these records and APIs. Use existing identity/workspace access ports and project visibility checks. Preserve the existing host-management role policy in addition to workspace membership; ordinary access to a project does not authorize enrolling or replacing hosts. Machine polling is authorized only for its current active assignments, not every project in its workspace.

Preserve legacy environment-token agents. Extend `env_provisioning.onprem_hosts` with an optional machine reference and an explicit credential-kind constraint: a legacy registration has its existing token hash/prefix, while a machine assignment has a machine reference and no legacy token fields. The existing active-environment unique index enforces exclusivity across both types. Keep the old registration API available during migration.

Machine authentication and legacy host authentication use distinct credential prefixes and a shared authorization result that identifies allowed active environment assignments. Assignment and status APIs validate the current binding when reading and writing. Revoking, replacing, or unassigning a machine must prevent new assignment reads and status updates for that binding, including under concurrent requests. A machine never acquires authority merely by reporting a project/environment ID in its payload.

Raw machine credentials are returned once at successful enrollment and stored only in protected host files. Databases store hashes. A retry after a lost enrollment response must not reveal the existing credential; an authenticated operator can issue a fresh enrollment/rotation. Reinstallation requires an explicit replacement choice and revokes the prior credential. A stale installer cannot silently replace an existing machine or environment registration.

## Enrollment and installer experience

The user opens workspace Hosts, chooses Add host, enters its name/platform, and obtains a versioned installer plus short-lived enrollment code. The installer accepts the code interactively so it does not require embedding long-lived credentials in shell history or URLs. Downloads use a controlled release source and checksums pinned by the installer. Installation is idempotent and keeps explicit operator configuration.

The Windows installer checks virtualization, supported WSL, the selected distro, and the owning Windows account. It installs or prepares prerequisites where possible, records resumable state if a restart is needed, and continues enrollment after the operator resumes. It reuses the current startup/port-forwarding scripts. A Linux installer checks the supported Ubuntu baseline, Docker Engine/Compose, systemd, curl, jq, openssl, trust, disk, and API access. Existing Docker installations/configuration must not be overwritten automatically.

Before enabling deployments, install configuration and public trust material, protect credentials, verify the API connection and agent execution, and enable automatic startup. Start the polling timer after configuration is complete rather than starting an agent that repeatedly fails until manual edits are finished.

Windows elevation, a required reboot, customer network/subnet choices, and private-registry authentication are explicit operator steps when needed. The product explains the required action and resumes; it must not claim zero-touch installation on an unprepared Windows machine. Network rules are limited to the operator-selected application ports/subnets. The agent's control connection is outbound; installing it does not open an inbound remote administration endpoint.

## Multiple projects on one machine

Run one machine supervisor as a system service. It retrieves active assignments, renders assignment-specific configuration, and runs the existing deployment worker separately for each environment. Keep worker state under `/opt/alphaci/assignments/<project-id>/<environment-id>/`. Use a stable Compose project name derived from the globally unique environment UUID, such as `ac-<environment-uuid-without-dashes>`. Give each assignment separate Compose networks, volumes, health configuration, current/previous release files, and logs.

Serialize deployment/rollback within an environment using a local assignment lock. Different environments may progress independently. Reserve application ports transactionally per machine and check that the actual ports are available before starting a new stack. A reservation/conflict becomes an actionable assignment error; it must not stop an existing stack. Template-supplied health paths are editable and persisted. Application HTTP health must be configured or explicitly reported as absent, never implied by a connected host badge.

For the laptop test, allocate distinct application ports and show usable local/LAN URLs. Production custom hostnames/TLS use explicit ingress configuration and readiness checks. Installing an additional project must not replace the machine's global proxy configuration, another project's ports, or its secrets. Private image-pull credentials stay on the host and are restricted to the required registry/repositories.

Unassignment stops the worker from accepting new work and preserves application data. Stopping an application stack or deleting its data is a separate explicit action. Revocation cannot stop Docker commands already executing or erase a container on an offline machine. The UI describes these limits when replacing a host. Logical project isolation within one Docker daemon is not a boundary for mutually untrusted customer workloads; those use separate machines.

## UI and state contracts

Hosts exposes machine name, platform, agent version, last check-in, assigned environments, and actionable prerequisite failures. Heartbeats run every 30 seconds; a host with no check-in for 90 seconds appears offline. Report separate states for enrollment pending, connected, prerequisites failed, offline, and revoked. Heartbeats do not themselves prove a deployed application is healthy.

Project setup offers an existing host or Add host for each on-prem environment. Existing projects can attach a host from Hosting. Keep existing environment/promotion rules. Show deployment readiness per environment with reasons such as API unreachable, signing unverified, no host assigned, host offline, registry authentication required, or port conflict. A target record marked active is not displayed as a healthy running application without deployment evidence.

Adding a host, assigning it to a project, and replacing it remain separate explicit operations. Host/token replacement is not triggered by opening a page, clicking Retry, or reinstalling the same package. UI retry operations are safe against duplicate enrollment, binding, and registration requests.

## Verification and rollout

Required checks before claiming the full flow works:

1. Reproduce the current on-prem history failure, then verify successful empty and populated history, unavailable database behavior, mixed cloud/on-prem projects, preview consumption, and project/environment filtering.
2. Verify the targeted migration against duplicate legacy hosts, replay, concurrent registration, rollback, and the actual remote index after the operator runs it.
3. Verify GitHub-hosted CI can authorize and report results through the selected tunnel, build/publish the frontend image, register its release, and produce a signature accepted by backend and host.
4. Test one-use enrollment under concurrent consumption, expiry, workspace/role denial, lost responses, installer retry, credential rotation, and revoked-machine/binding status writes.
5. Test clean and repeated Windows/Ubuntu installation. Verify Windows restart recovery and system startup separately from an interactive WSL session. Report unsupported or untested platform conditions honestly.
6. Use two projects on one physical test host. Deploy concurrently, promote independently, update A while B's containers/data remain unchanged, and fail A health so rollback preserves B. Include port conflicts and concurrent assignment changes.
7. Verify assignment removal/replacement and machine revocation deny subsequent API access while preserving unrelated projects and application data.
8. Run backend lint/typecheck/unit/architecture/documentation gates, appropriate database-backed E2E tests, and frontend lint/typecheck/focused tests. Use disposable PostgreSQL for automated tests. Shared Supabase receives only reviewed targeted operator migrations.

Roll out repairs before new enrollment. Add schema and backend support before exposing the new frontend. Upgrade installers and supervisor before offering machine assignments. Keep legacy agents supported. A downgrade must first detach machine assignments and restore explicit legacy registrations; do not drop machine records while active assignments depend on them. Revoked credentials remain revoked.

Record code, database, frontend, workflow regeneration, agent installation, and real deployment evidence separately. Product source changes use separate backend/frontend branches and PRs. No automatic push, PR merge, or production rollout follows design approval.

## Exclusions

This design does not provide Kubernetes, offline/air-gapped CI, arbitrary SSH access, host autoscaling, automatic customer DNS ownership, automatic production certificate issuance, or a fully self-hosted AlphaCI platform image. It preserves Docker Compose customer-project delivery and remote Supabase for the requested test.

## Review checklist

- Immediate project repairs can ship before the new machine management feature.
- Existing environment tokens remain valid until explicitly replaced/revoked.
- Active assignment exclusivity covers both legacy agents and enrolled machines.
- One machine can run several authorized project environments without shared deployment state or port collisions.
- Public API connectivity, signing, registry access, host connectivity, and application health have separate evidence.
- Installer retries and Windows restarts cannot consume another enrollment or replace an unrelated registration.
- No raw token, enrollment code, private signing key, or registry secret appears in logs, generated repository files, or diagnostics.
- Proposed behavior is not represented as current runtime capability.
