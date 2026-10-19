---
type: "Playbook"
title: "On-prem host setup"
description: "Set up an Ubuntu or Windows (WSL2) machine as an AlphaCI on-prem host: server settings, enrollment, assignment, addresses, signing, and operation."
tags: [runbook, runtime, deployment, on-prem]
status: stable
sources:
  - id: agent
    resource: "deploy/onprem/agent"
    title: "Host agent, installer, and systemd units"
  - id: windows
    resource: "deploy/onprem/windows"
    title: "Windows and WSL startup scripts"
  - id: deb
    resource: "deploy/onprem/deb"
    title: "Ubuntu package scripts"
  - id: assignments
    resource: "src/modules/runtime/application/onprem/onprem-assignments.service.ts"
    title: "Automatic assignment, default ports, and addresses"
  - id: release-registry
    resource: "/architecture/release-registry.md"
    title: "Release registry contract"
---
# On-prem host setup

An on-prem host is an Ubuntu machine (or an Ubuntu WSL2 distro on Windows) that runs a project's environments with Docker Compose. The host only makes outbound calls. Its supervisor checks in with AlphaCI every 30 seconds, pulls the deployments assigned to it, verifies each release signature against its trust file, pulls the images by digest, starts them, checks health, and reports the result. A release that fails its health check is replaced by the previous one.

The AlphaCI server is either the self-hosted appliance ([install runbook](runbook-selfhost-install.md)) or a hosted backend such as the Render service. The server settings differ. Everything from [Prepare the machine](#prepare-the-machine) onwards is the same for both.

## Requirements

| Need | Value |
|---|---|
| Machine | Ubuntu 24.04, or Windows 10 22H2 / Windows 11 with virtualization on and an Ubuntu WSL2 distro. 16 GB RAM recommended. At least 1 GiB free under `/opt`. |
| Access | Root on the machine (administrator on Windows). In AlphaCI, an application role of Admin or Developer (`admin` or `member`) and membership of the team (workspace) as admin, delegated lead, or member. |
| Outbound HTTPS | The AlphaCI address, `ghcr.io`, `pkg-containers.githubusercontent.com`, `github.com` (installer and cloudflared downloads), `download.docker.com`, Ubuntu package mirrors. Cloudflare, for the automatic HTTPS address (tunnel). |
| Inbound | None for the agent. Only the application ports, from the networks that use the apps, when users reach the apps directly. |

## Server settings

Do this once per AlphaCI server.

### Self-hosted appliance

1. In `alphaci.env`, uncomment and fill in the on-prem block from `deploy/selfhost/alphaci.env.example`:
   - `ONPREM_RELEASES_ENABLED=true`
   - `ENV_PROVISIONING_ENABLED=true`
   - An installer source (see [Installer source](#installer-source)).
   - `ONPREM_INSTALLER_VERSION` set to the agent version you serve. The current agent is `0.4.3` (`deploy/onprem/agent/release-manifest.json`). Without the setting the server serves `0.2.0`, which has no automatic HTTPS address, no linked services, and no registry pull credential.
2. Releases are signed by the server's own key (`ALPHACI_RELEASE_SIGNER=file`). Enrollment hands that key to every host automatically. `ALPHACI_RELEASE_TRUST_KEYS_JSON` is needed only for extra keys, such as the previous key during a rotation.
3. If the release images are private, save a pull token: `./alphaci-ctl registry-token --github-login <token owner>`. See [Private release images](#private-release-images).
4. Apply the settings with `docker compose up -d`, then run `./alphaci-ctl doctor`. While `ONPREM_RELEASES_ENABLED=true`, doctor adds two checks: `on-prem settings are present and valid` names each missing or malformed setting, and `release trust key for on-prem hosts is available` prints the key ID that enrollment trusts.

To run deployments on the AlphaCI server itself, use `alphaci-ctl server-host`, described in the install runbook under [Run deployments on the AlphaCI server](runbook-selfhost-install.md#run-deployments-on-the-alphaci-server).

### Hosted backend

Set these in the hosting service's environment (for example the Render service's Environment page), then redeploy. Do not commit values.

| Variable | Value |
|---|---|
| `PLATFORM_PUBLIC_URL` | Public HTTPS origin, for example `https://api.example.com`, with no path, query, or credentials. Enrollment hands it to every host, and hosts call it on every check-in, so keep it stable. |
| `TRUST_PROXY_HOPS` | Reverse proxies in front of the API. Default `1` (Render's edge alone). Set `2` only while a Vercel rewrite proxies the API. Never higher than the real chain. |
| `ONPREM_RELEASES_ENABLED` | `true` |
| `ENV_PROVISIONING_ENABLED` | `true` |
| `ALPHACI_RELEASE_TRUST_KEYS_JSON` | One-line JSON object mapping each trusted key ID to its PEM public key. See [Release signing on a hosted backend](#release-signing-on-a-hosted-backend). |
| Signing source | Cloud KMS settings, or the lab key for lab hosts. See the same section. |
| `ONPREM_INSTALLER_VERSION` | The agent version to serve, for example `0.4.3`. Default `0.2.0`. |
| Installer source | `ONPREM_INSTALLER_RELEASE_REPO` and, recommended, `ONPREM_INSTALLER_SHA256`. See [Installer source](#installer-source). |
| `ONPREM_INSTALLER_RELEASE_TOKEN` | Optional. A GitHub token used only for API calls, to avoid the unauthenticated rate limit. Secret. |
| `ONPREM_REGISTRY_TOKEN_FILE`, `ONPREM_REGISTRY_USERNAME` | Optional. The pull credential lent to hosts. See [Private release images](#private-release-images). |

Apply the migrations before the backend that needs them starts: `npm run db:apply:all`, as the [database migrations runbook](runbook-database-migrations.md) describes. Every migration is idempotent, so a rerun is a safe recovery step.

### Installer source

Enrollment issues no code until the server can name a verified installer archive (`alphaci-agent-<version>.tar.gz`). Without one, **Add host** answers 503 `Publish or configure a verified installer release before enrolling a host.` Choose one source:

- **GitHub release.** `ONPREM_INSTALLER_RELEASE_REPO=owner/repo` names a repository with a release tagged `onprem-agent-v<version>`. The repository must be public, because machines download the archive without credentials. Set `ONPREM_INSTALLER_SHA256` to the archive's hash to pin it. Without a pin, the release must be marked immutable, and the hash comes from its `installer-release.json`. A pinned hash is checked against the archive bytes at most every 10 minutes.
- **Explicit URL.** `ONPREM_INSTALLER_URL` (HTTPS) with `ONPREM_INSTALLER_SHA256`. A complete URL and hash pair takes priority over the release lookup. A URL without its hash refuses enrollment.
- **Archive served by the server.** `ONPREM_INSTALLER_PATH` names an archive file the backend process can read. `GET /api/v1/onprem/installer/<version>` then serves it, only while `<version>` equals `ONPREM_INSTALLER_VERSION` and the bytes match `ONPREM_INSTALLER_SHA256`. Enrollment still needs a source above, so point `ONPREM_INSTALLER_URL` at `https://<server>/api/v1/onprem/installer/<version>`. The appliance's `compose.yaml` mounts no archive into `api`, so add the mount yourself (for example in `compose.override.yaml`).

Build an archive locally with `node scripts/package-onprem-agent.mjs`. It writes `artifacts/onprem/alphaci-agent-<version>.tar.gz`, its `.sha256`, and `installer-release.json`, and prints the hash.

### Publish an installer release

1. Merge a change that sets `version` in `deploy/onprem/agent/release-manifest.json`. The tag must match it, or the workflow fails.
2. On the merged commit, push an annotated tag:

   ```bash
   git tag -a onprem-agent-v0.4.3 -m "On-prem agent 0.4.3"
   git push origin onprem-agent-v0.4.3
   ```

3. The **On-prem agent release** workflow (`.github/workflows/onprem-agent-release.yml`) creates the GitHub Release with five assets: `alphaci-agent-<version>.tar.gz`, its `.sha256`, `installer-release.json`, `alphaci-agent_<version>_all.deb`, and its `.sha256`. Manual dispatch from a branch only builds the files as a workflow artifact.
4. Check the release, then set `ONPREM_INSTALLER_VERSION` and `ONPREM_INSTALLER_SHA256` on the server. Codes issued afterwards carry the new archive. A code issued earlier keeps the release it was issued for.

Protect the repository before the first customer enrolls. These are repository settings, made by an administrator: turn on immutable releases, and add a tag ruleset for `onprem-agent-v*` that blocks updating and deleting tags. If a release is wrong, publish the next version. The archive is not signed; its trust comes from the pinned hash, or from an immutable release's `installer-release.json`.

## Prepare the machine

### Ubuntu

Install Docker Engine and the Compose plugin from Docker's repository, and the agent's tools:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl jq openssl util-linux iproute2
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

The installer checks these before it reads the enrollment code: Ubuntu, `curl`, `jq`, `openssl`, `flock`, `sha256sum`, `docker`, `systemctl`, `ss`, a running Docker Engine with Compose v2, systemd, `ca-certificates`, and 1 GiB free under `/opt`. It installs `cloudflared` when it is missing (amd64 and arm64). It keeps an existing Docker configuration.

### Windows (WSL2)

1. In PowerShell as administrator: `wsl --install -d Ubuntu-24.04`, then restart when asked. A virtualization error means VT-x or AMD-V is off in the firmware.
2. Open **Ubuntu** from the Start menu and create the Linux user. Use the Windows account that will own the distro.
3. In Ubuntu, `systemctl is-system-running` must print `running` or `degraded`. If not, enable systemd, run `wsl --shutdown` in PowerShell, and reopen Ubuntu:

   ```bash
   sudo sh -c 'printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf'
   ```

4. Install Docker inside Ubuntu as in [Ubuntu](#ubuntu). Do not use Docker Desktop on a host. If it is installed, turn off its WSL integration for this distro.

## Enroll the machine

1. In AlphaCI, open **Hosts** for the team and choose **Add host**. Choose the platform.
2. Run one of these on the machine. Each code works once and expires 10 minutes after it is issued.

   | Method | What to run |
   |---|---|
   | Install file | Download `alphaci-install-<machine>.sh` (Ubuntu) or `alphaci-install-<machine>.cmd` (Windows), run it once, then delete it. It carries the code. |
   | Command | Copy the checksum-verifying command from Hosts. On Ubuntu it ends with `install.sh --enroll <API URL>`. On Windows it runs `Install-AlphaCIHost.ps1 -ApiUrl <API URL>` in administrator PowerShell, as the account that owns the distro. Paste the code at the hidden prompt. |
   | Ubuntu package | See [Ubuntu package (.deb)](#ubuntu-package-deb). |
   | Self-enrolling image | See [On-prem self-enrolling images](runbook-onprem-self-enrolling-images.md). |

3. Wait for **Connected** in Hosts. The installer runs a first check-in, then starts `alphaci-machine.timer`. If that check-in fails, the timer keeps retrying every 30 seconds.

Enrollment writes the credential (`/opt/alphaci/secrets/machine-token`), `/opt/alphaci/machine.json` (machine ID, API address, agent version), and `/opt/alphaci/trust.json` (the server's trusted signing keys), all root-only. Codes are never command arguments. They come from the hidden prompt or from a code file (`ALPHACI_ENROLL_CODE_FILE`). A code file is deleted once AlphaCI answers (accepted, or refused as invalid, used, or expired). It is kept when the server could not be reached, was busy, or throttled, so the same command can run again. A saved, root-only enrollment response lets an interrupted install resume without a new code.

On Windows, `Install-AlphaCIHost.ps1` saves a non-secret installation ID and phase. If Windows features need a restart, restart and rerun the same command. It reports a missing distro, WSL1, missing systemd, and missing Ubuntu prerequisites by name.

Rerunning an install on an enrolled machine keeps the existing enrollment (`Existing machine enrollment retained`). To use a replacement code, see [Replace, retire, or move a machine](#replace-retire-or-move-a-machine).

### Ubuntu package (.deb)

Each `onprem-agent-v<version>` release attaches `alphaci-agent_<version>_all.deb` and its `.sha256`.

1. Verify the download: `sha256sum -c alphaci-agent_<version>_all.deb.sha256`.
2. Install Docker first, as above, otherwise apt installs `docker.io` as a recommended package. Then `sudo apt-get install ./alphaci-agent_<version>_all.deb`. The package lays out `/opt/alphaci` and the machine units. It does not enroll and does not start polling. It does not ship `cloudflared`; install it separately for the automatic HTTPS address.
3. Enroll: `sudo alphaci-enroll https://YOUR-API`, and paste the code. From a code file: `sudo env ALPHACI_ENROLL_CODE_FILE=/path/to/code alphaci-enroll https://YOUR-API`. Add `--replace` for a replacement code.
4. Wait for **Connected**.

Removing the package stops polling. Credentials, trust keys, and assignment data stay under `/opt/alphaci` until someone deletes them.

### Windows startup and client access

The Windows install keeps the distro running and forwards the application ports into WSL:

- **AlphaCI Host** task, as the distro's owner: keeps the distro running.
- **AlphaCI Port Forward** task, as SYSTEM, at startup and every minute: points `netsh portproxy` at the distro's current address for every host port AlphaCI reserved on the machine (read from `/opt/alphaci/published-ports.json`), plus any `-Ports`.
- **AlphaCI TCP &lt;port&gt;** inbound firewall rules, only from `-ClientSubnets`. Forwards and rules are removed when a port is no longer used.

`-OnlyWhenSignedIn` suits a test PC: the apps run while someone is signed in, and no password is stored. On a server, pass `-ServiceAccount DOMAIN\account` so the apps start at boot without a sign-in; the script asks for the account's password. Rerun the installer to change `-ClientSubnets`.

```powershell
.\Install-AlphaCIHost.ps1 -Distro Ubuntu-24.04 -ApiUrl https://YOUR-API -ServiceAccount DOMAIN\alphaci-svc -ClientSubnets 10.20.0.0/16
```

Test reboot recovery and client-network access on the machine itself.

## Assign environments

An environment whose targets all use on-prem Compose (`onprem-compose`) runs on one machine. Each assignment has a container port and a health path per slot, a host port per slot, and an ingress (how users reach it).

Automatic assignment runs when an environment is provisioned, or when a target is created or attached to it. It assigns the environment only when the team has exactly one connected machine:

- Non-production environments are assigned to it.
- Production is assigned only when the server has `ONPREM_APPS_DOMAIN` set, because production needs an HTTPS address. Otherwise assign production in **Hosting** and choose its address.
- With several connected machines, Hosting asks which machine to use.
- Automatic assignment does not run after a revocation.

When an environment gains or loses a slot, it is reassigned on the same machine. Kept slots keep their settings and host ports.

### Ports and health paths

AlphaCI picks each host port from 8080 to 8999, lowest free first. A host port is never handed out twice on one AlphaCI server, across machines too. The container port and health path start from the app AlphaCI scaffolded for the project:

| Scaffolded app | Slot | Container port | Health path |
|---|---|---|---|
| NestJS | backend | 3000 | `/health` |
| Node.js | backend | 3000 | `/health` |
| .NET | backend | 8080 | `/health` |
| Next.js | frontend | 3000 | `/` |
| React (nginx) | frontend | 8080 | `/` |

The Node.js starter has no HTTP server yet. Add one that listens on `PORT` and answers `/health`, or change the health path in Hosting. A repository AlphaCI did not scaffold starts from 3000 for a frontend and 4000 for a backend, with health at `/`. Set the real values in Hosting.

An environment keeps its stored ports. If its health check fails because the port is wrong, open it in Hosting, choose **Change machine or ports**, set the container port and health path, and save. The next deployment uses them.

On the machine, each assignment uses `/opt/alphaci/assignments/<project ID>/<environment ID>`, the Compose project `ac-<environment ID without dashes>`, its own network and named volumes (mounted at `/var/lib/alphaci-data`), a worker lock, release state, and `worker.log`. A host port held by anything other than this environment's own container blocks the deployment with `Port <n> is occupied outside this assignment; no stack changed.`

### Addresses

Choose how users reach the environment ("How users reach it" in Hosting or in the create wizard):

- **Automatic HTTPS address.** The default for an environment that runs a frontend. A backend alone defaults to direct access.
  - With `ONPREM_APPS_DOMAIN` set on the server, the address is permanent: `https://<repository>.<domain>` for production and `https://<environment>-<repository>.<domain>` for other environments. This is for deployments on the AlphaCI server itself, whose Caddy routes the names. See the install runbook.
  - Without it, the machine runs a Cloudflare quick tunnel (below).
- **Through an existing proxy or domain.** Enter an HTTPS URL that the customer's own proxy, DNS, or named tunnel serves, pointing at the environment's frontend host port (Hosting lists it as "port N → 3000").
- **Direct.** The host port on the machine's own network. Not allowed for production.

QA Studio and previews open the environment's current address: the configured or apps-domain URL, or the running tunnel.

### Automatic HTTPS address (tunnel)

The machine runs a Cloudflare quick tunnel from the environment's frontend host port and reports its `https://<words>-<words>.trycloudflare.com` address with each check-in. Hosting shows it under "Reached at". Only addresses of that form are reported.

Production waits for the tunnel. Until a running tunnel reports its address, AlphaCI does not hand production releases to the machine, and Hosting says "Waiting for the HTTPS address." Other environments deploy without waiting.

Requirements:

- Agent 0.3.0 or newer. Readiness asks for an update otherwise.
- `cloudflared` 2026.10.0 or newer on root's `PATH`. The agent refuses older or unversioned binaries, and Hosting shows the reason.
- Outbound HTTPS only. No inbound port opens.
- The environment's stack must answer on its host port. The tunnel forwards whether or not a release is healthy.

Each tunnel is the unit `alphaci-tunnel@<environment ID>.service`, configured by `/opt/alphaci/tunnels/<environment ID>/tunnel.env`. It runs as the unprivileged user `alphaci-tunnel`, can write only its `run/` directory (also its `TMPDIR`), has no capabilities, and uses an empty cloudflared config. systemd restarts it 15 seconds after it stops. The supervisor starts the unit when an assignment uses the tunnel and stops it when the assignment leaves. Logs:

```bash
journalctl -u 'alphaci-tunnel@*' -n 200 --no-pager
```

**A quick-tunnel address changes when the tunnel restarts**: after a reboot, after cloudflared exits, or after the port changes. The new address appears on the next check-in. Tell users, and update any link, webhook, or OAuth redirect that uses it. Cloudflare documents quick tunnels for testing. For production without an apps domain, use a named tunnel or proxy on the customer's domain and choose **Through an existing proxy or domain**. AlphaCI does not create or rotate named tunnels.

A machine stops all its tunnels when its credential is rejected (HTTP 401) at check-in, and on uninstall.

### Two repositories on one machine

A two-repository project has one AlphaCI project per repository. To run them together, assign the environment with the same slug (for example `dev`) of both projects to the same machine. Both halves need agent 0.4.0 or newer; with an older agent they deploy unlinked and readiness shows a failed `service-link` check.

On deployment, the agent creates the Docker network `alphaci-<pair>-<environment>` and attaches both containers, aliased `backend` and `frontend`. The frontend gets `API_URL=http://backend:<port>`. The backend gets `FRONTEND_URL` and `CORS_ORIGINS` on its next deployment after the frontend has a public address. Verify with `docker exec <frontend container> printenv API_URL` and `docker network inspect alphaci-<pair>-<environment>`.

Moving either half to another machine, unassigning it, or assigning a second frontend or backend to that environment ends the link. The agent does not remove the network; remove it with `docker network rm` once no container uses it.

### Private release images

With `ONPREM_REGISTRY_TOKEN_FILE` set (a token with `read:packages` for the organization) and `ONPREM_REGISTRY_USERNAME` (the token's owner), AlphaCI lends that credential with each assignment. Agent 0.4.3 logs in to a throwaway Docker config for the pulls only, so the credential never stays in the host's Docker login. `ONPREM_REGISTRY_SERVER` defaults to `ghcr.io`. On the appliance, `alphaci-ctl registry-token` sets both values.

Without it, the host pulls with its own Docker login. Log in as root, because the agent runs as root:

```bash
sudo docker login ghcr.io -u YOUR_GITHUB_USERNAME
```

## Deploy and verify

1. Push to the environment's source branch. The package workflow builds the images and registers the release. The first environment deploys on registration; later environments deploy on **Promote**.
2. Watch the environment's readiness and deployment in Hosting. `Connected` means the machine checks in; it does not mean the application is healthy.
3. On the machine:

   ```bash
   journalctl -u alphaci-machine.service -n 50 --no-pager
   sudo tail -n 20 /opt/alphaci/assignments/<project ID>/<environment ID>/worker.log
   ```

   A healthy deployment logs `deployment <deployment ID> healthy`.
4. Open the environment's address. On Windows, restart the PC and confirm the address works again.

## Operate

### Diagnostics

Run `sudo /opt/alphaci/bin/alphaci-supervisor support-bundle`. It writes `/opt/alphaci/support/machine-<time>.tar.gz` with the machine record, the supervisor and tunnel journals, running containers, and each assignment's current release. It never contains the credential, but review it before sending. On Windows, `Export-AlphaCIHostSupport.ps1` collects the same through WSL.

### Update the agent

Readiness names the agent version a feature needs (0.3.0 for the tunnel, 0.4.0 for linked services, 0.4.3 for the registry pull credential). To update an enrolled Ubuntu machine, download and verify the new `alphaci-agent-<version>.tar.gz`, extract it, and run `sudo bash agent/install.sh --enroll https://YOUR-API`. The installer replaces the agent files and keeps the existing enrollment (`Existing machine enrollment retained`), so no code is needed. With the package, install the new `.deb` with `apt-get`. The next check-in reports the new version.

### Agent request limits

The agent endpoints (`POST /onprem/heartbeat`, `GET /onprem/assignments`, `POST /onprem/deployments/:deploymentId/status`) allow, per minute and per endpoint, 120 requests per machine and 300 per client address. Requests with an unknown or revoked credential count against the address, and each address gets 30 lookups a minute that find no machine. A machine over a limit gets `429` with `Retry-After: 60` and needs no action. `POST /onprem/enroll` allows 5 requests per minute per client address, so enroll machines behind one NAT one at a time. Counters live in each API instance's memory. The client address comes from `TRUST_PROXY_HOPS`.

### Replace, retire, or move a machine

- **Replace the credential.** In Hosts, open the machine's card, choose **Replace credential**, then **Confirm new credential**. Run the install file or command it shows; each already includes `--replace` (Windows: `-ReplaceCredential`). The old credential works until the new code is used, and is restored if the code is not accepted. Enrollment does not stop containers. The machine's environments move to the new record with the same host ports where they are free.
- **Retire a machine.** Enroll its replacement with a replacement code, or revoke it naming the replacement: its environments move with their host ports where free. Revoking also ends the machine's pending replacement code, so consume that code first.
- **Revoke without a replacement.** **Revoke access** ends the machine's environment bindings and releases their host ports. Running applications stay on the machine, unmanaged, until each environment is assigned again in Hosting. A fresh enrollment on that machine needs `--replace` (or `-ReplaceCredential`) added by hand; without it `enroll.sh` prints `Existing machine enrollment retained` and keeps the revoked credential.
- **Move to another AlphaCI server.** `enroll.sh` refuses a different API address unless `--replace` is given with a code from the new server. If the new server uses the same database, create the enrollment with `replacesMachineId` (`POST /workspaces/:workspaceId/onprem-host-enrollments`) so the old record is revoked. With a different database, stop the timer and move the old enrollment aside first:

  ```bash
  sudo systemctl disable --now alphaci-machine.timer
  sudo sh -c 'install -d -m 0700 /opt/alphaci/enrollment-backup
  for file in machine.json trust.json secrets/machine-token secrets/enrollment-response.json; do
    if [ -e "/opt/alphaci/$file" ]; then mv "/opt/alphaci/$file" /opt/alphaci/enrollment-backup/; fi
  done'
  ```

  Then enroll with the new code (`install.sh --enroll https://NEW-API ubuntu`), wait for **Connected**, reassign environments, and delete `/opt/alphaci/enrollment-backup`.

Revoking or unassigning cannot cancel a Docker command already running. Use separate machines for mutually untrusted workloads.

To make an existing machine trust a new signing key, see [Switching an existing host to the install's signing key](runbook-selfhost-install.md#switching-an-existing-host-to-the-installs-signing-key).

### Uninstall

- Ubuntu: `sudo ./uninstall.sh` from the `agent` directory of the installer archive. It disables the polling timers, then stops every tunnel.
- Windows: `Uninstall-AlphaCIHost.ps1` in administrator PowerShell removes the tasks, port forwards, and firewall rules, and runs the same stop through WSL.

Containers, credentials, and data remain until removed. Revoke the machine in AlphaCI too. Back up application data before deleting anything; `wsl --unregister <distro>` deletes the whole distro.

## Release signing on a hosted backend

The self-hosted appliance signs releases itself (`ALPHACI_RELEASE_SIGNER=file`) and needs nothing in this section. A hosted backend with the signer unset or `runner` has CI sign each release in a generated sign-release job, with Cloud KMS for client hosts or a lab key for lab hosts.

### Cloud KMS (client hosts)

Use an ECDSA P-256 key that signs with `EC_SIGN_P256_SHA256`. The key version's resource name is the release key ID:

```text
projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION
```

1. Export its public key and build the trust entry:

   ```bash
   gcloud kms keys versions get-public-key VERSION --key=KEY --keyring=RING --location=LOCATION --project=PROJECT --output-file=alphaci.pub
   jq -nc --arg id "projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION" --rawfile pem alphaci.pub '{($id):$pem}'
   ```

2. Create a signer identity for signing only. Do not reuse the Cloud Run runtime pool (`GCP_WORKLOAD_IDENTITY_PROVIDER`):
   - Grant the signer service account `roles/cloudkms.signerVerifier` on the key or key version, and nothing broader.
   - Create a GitHub provider with issuer `https://token.actions.githubusercontent.com`, map `google.subject` to `assertion.sub` and `attribute.repository` to `assertion.repository`, and restrict it with an attribute condition to the client's organization.
   - Grant `roles/iam.workloadIdentityUser` on the signer service account to `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/attribute.repository/OWNER/REPO` for each signing repository, or one `attribute.repository_owner/OWNER` grant for the organization.
3. Set on the backend: `ALPHACI_RELEASE_TRUST_KEYS_JSON` (the trust entry), `ALPHACI_RELEASE_KMS_KEY_VERSION`, `ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER`, and `ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT`. Set all three Cloud KMS settings together.

When a project with an on-prem target is created, AlphaCI sets the repository variable `ALPHACI_RELEASE_KMS_KEY_VERSION` and writes the signer identity into the sign-release job. Set the backend values before the project is created. If they change later, regenerate the project's workflows. An on-prem target added to an existing project is refused until its repository can sign: set the Cloud KMS settings, regenerate the workflows, then add the target again.

### Lab key (lab hosts only)

```bash
openssl ecparam -name prime256v1 -genkey -noout -out release-signing.key
openssl pkey -in release-signing.key -pubout -out release-signing.pub.pem
KEY_ID="sha256:$(openssl pkey -in release-signing.key -pubout -outform DER | sha256sum | cut -d' ' -f1)"
jq -nc --arg id "$KEY_ID" --rawfile pem release-signing.pub.pem '{($id):$pem}'
```

Make the private key readable by the backend process (on Render, a secret file under `/etc/secrets/`) and set `ONPREM_LAB_SIGNING_KEY_PATH` to it. Add the trust entry to `ALPHACI_RELEASE_TRUST_KEYS_JSON`. Provisioning copies the key into the repository secret `ALPHACI_RELEASE_SIGNING_KEY`. Cloud KMS wins when it is configured; an incomplete Cloud KMS configuration is an error, not a lab fallback. Client hosts must not use a lab key.

### Signing warnings at project creation

Project creation returns `releaseSigningWarning` when signing could not be set up:

| Warning | Fix |
|---|---|
| Names `ALPHACI_RELEASE_SIGNING_KEY` | The lab key could not be read, is not P-256, or the secret could not be written. Fix `ONPREM_LAB_SIGNING_KEY_PATH` or the GitHub permission, then add the secret by hand under **Settings**, **Secrets and variables**, **Actions**. |
| Says releases would not verify and the lab secret was not written | Add the lab key's ID and PEM to `ALPHACI_RELEASE_TRUST_KEYS_JSON`, then add the secret by hand. |
| Names `ALPHACI_RELEASE_KMS_KEY_VERSION` | The variable could not be written, or the Cloud KMS settings are incomplete. Complete them, regenerate the workflows, then add the variable by hand. |
| Says releases will not verify and names `ALPHACI_RELEASE_KMS_KEY_VERSION` | Add that key version to `ALPHACI_RELEASE_TRUST_KEYS_JSON`. No repository change is needed. |

If signing fails or is cancelled for a first on-prem environment, the generated workflow reports the pending deployment as failed. If that cleanup could not run, a project CI token can report it: `POST /api/v1/ci/releases/<release-id>/deployment-status` with `{"repoFullName":"owner/repo","status":"failed","detail":"Signing did not complete."}`. A retry needs a release from a new workflow run.

### Rotate the Cloud KMS key

1. Create the new key version and export its PEM.
2. On the backend, set `ALPHACI_RELEASE_KMS_KEY_VERSION` to the new name and add it to `ALPHACI_RELEASE_TRUST_KEYS_JSON`. Keep the old entry until no release signed with the old key can still be promoted or deployed.
3. In each on-prem project's repository, change the variable `ALPHACI_RELEASE_KMS_KEY_VERSION`. Existing repositories keep the old value.
4. Enrolled machines get the trust keys at enrollment. Replace each machine's credential so its `trust.json` includes the new key, or add the entry by hand as the install runbook's Option B describes. Do this before a release signed with the new key reaches the machine.

Regenerate workflows only when the signer identity changes.

## Legacy single-environment hosts

A legacy host serves one environment with a host token, `/opt/alphaci/agent.env`, and `alphaci-agent.timer`. AlphaCI keeps an existing legacy registration until someone replaces it with a machine assignment. Use machine enrollment for new hosts.

- Registration: the environment card's **Register host** in Hosting (`POST /projects/:projectId/environments/:environmentId/hosts`). The token is shown once. Registering again revokes the environment's earlier tokens; stop the old agent first.
- Install: `sudo bash agent/install.sh` (no arguments). It installs `/opt/alphaci/bin/alphaci-agent`, the example `compose.example.yaml` and `Caddyfile.example` under `/opt/alphaci/compose/`, and `agent.env`. The timer is enabled only once `agent.env` has an HTTPS `ALPHACI_API_URL`, the token file (`/opt/alphaci/secrets/host-token`, mode 0600) exists, the Compose file (`/opt/alphaci/compose/compose.yaml`) exists, and the trust key (`/opt/alphaci/trust/release-signing.pub.pem`) is a public key. Rerun the installer after configuring them.
- The legacy agent verifies each release with the single PEM at `ALPHACI_TRUST_KEY` and does not compare key IDs. `ALPHACI_HEALTH_URL` is optional and must answer 2xx after a deployment and after a restore.
- Logs: `journalctl -u alphaci-agent.service`. Diagnostics: `sudo /opt/alphaci/bin/alphaci-agent support-bundle`.
- Windows: `Install-AlphaCIHost.ps1` without `-ApiUrl` forwards port 443 by default.
- Removal: `sudo systemctl disable --now alphaci-agent.timer`, then `sudo docker compose -p alphaci -f /opt/alphaci/compose/compose.yaml down`.

## Troubleshooting

| Symptom | Check |
|---|---|
| **Add host** returns 503 "Publish or configure a verified installer release before enrolling a host." | The installer source. Check `ONPREM_INSTALLER_RELEASE_REPO`, `ONPREM_INSTALLER_VERSION`, and the release assets, or the URL and hash pair. The backend log names the failed check. |
| **Add host** or enrollment returns 503 "Configure the public HTTPS API address first." | `PLATFORM_PUBLIC_URL` must be an HTTPS origin with no path, query, or credentials. |
| Hosts, enrollment, or check-in returns 403 "On-prem delivery is disabled." | `ONPREM_RELEASES_ENABLED` is not `true`. |
| Backend log: "The release is not immutable" | No hash is pinned and the release is mutable. Turn on immutable releases, or set `ONPREM_INSTALLER_SHA256`. |
| Backend log: "Installer archive does not match its expected SHA-256" | The archive differs from the pin or from `installer-release.json`. Check the release and the pin. |
| Machine stays offline | `journalctl -u alphaci-machine.service -n 50` and `systemctl list-timers alphaci-machine.timer`. A 401 means the credential was revoked or replaced. |
| Deployment failed: `Release key is not pinned on this host. Nothing was deployed.` | `trust.json` has no entry for the release's key ID. See the install runbook's switching procedure. |
| Deployment failed: signature, manifest hash, or project rejected | The trusted key does not match the key that signed the release, or the release belongs to another project. |
| Deployment failed: an image could not be pulled | Set a registry pull credential, or log in to `ghcr.io` with `sudo`, with a token that has `read:packages` and organization access. |
| Deployment failed: port occupied | Another process or container holds the host port. Free it, or change the port in Hosting. |
| Deployment rolled back, or the restored release reports failed | The new release, or the restored one, failed its health check. Read `worker.log` and the containers' logs (`sudo docker compose -p ac-<environment ID without dashes> logs --tail 200`). |
| Readiness `release-signing` failed | Hosted backend: Cloud KMS needs the key version and both signer settings, and the trust JSON must hold that exact key version. Lab: the key file must be readable and its ID trusted. Appliance: the signing key file must be readable. |
| Readiness `service-link` failed | One half runs an agent older than 0.4.0. Update the agent. |
| Hosting: "Waiting for the HTTPS address." | The tunnel has not reported an address. Check `cloudflared --version` (2026.10.0 or newer) and the tunnel journal. |
| Works on the Windows PC but not from other machines | `netsh interface portproxy show v4tov4`, and the **AlphaCI TCP &lt;port&gt;** rule's allowed networks. |
| Stops after sign-out or reboot | The tasks run only while signed in. Rerun the Windows installer with `-ServiceAccount`. |
