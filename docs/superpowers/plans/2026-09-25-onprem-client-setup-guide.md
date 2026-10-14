# On-prem client setup guide (onprem-compose)

How to set up a customer-hosted deployment target for a client's React and
.NET projects, from the test laptop to an enterprise Windows server.

**Status:** customer-host acceptance procedure. Local integration and verification
are recorded in the configurable deployment plan; client-host and reboot checks
remain unverified. The host bootstrap (`Install-AlphaCIHost.ps1`),
the host agent (`alphaci-agent`), the `onprem-compose` provider, and the
on-prem workflows are built by the
[configurable deployment targets plan](2026-09-25-configurable-deployment-targets.md).
Run section 0 and the acceptance checklist before any client.

## Chosen defaults

| Decision | Choice | Why |
|---|---|---|
| First workload | Customer React and .NET projects | Chosen by the product owner. AlphaCI itself stays on managed hosting. |
| Delivery path | `onprem-compose`: Windows + WSL2 Ubuntu + Docker Engine + Compose | Most first clients have one Windows server and no cluster. Kubernetes (`onprem-k8s`) comes later, for clients that already run it. |
| Connectivity | Connected: the host pulls from GHCR | Chosen by the product owner. Air-gapped bundles are a later tier. |
| Windows targets | Test: Windows 11 (our laptop). Clients: Windows Server 2022 | Server 2022 is the common enterprise baseline and supports WSL2. Add Server 2025 after the same checks pass. |
| Client host distro | Ubuntu 24.04 LTS | Docker publishes official Engine packages for it. |
| Container runtime | Docker Engine inside WSL (not Docker Desktop) | No GUI, licence, or signed-in user dependency on a server. |
| Signing | ECDSA P-256 with an AlphaCI-owned key in Google Cloud KMS; backend and hosts trust its public key | The private key never leaves KMS. The workflow signs the canonical manifest bytes; verification uses the configured PEM key and does not require a transparency service. |
| Desired state | The host agent polls the AlphaCI releases API for the approved release, then pulls images from GHCR by digest | Outbound only. AlphaCI never connects into the client network. |
| Status | Agent reports outbound to AlphaCI; if blocked, an operator exports a support bundle | Client firewalls usually block inbound traffic. |
| Ingress and TLS | Caddy container in the Compose stack, using the client's certificate or internal CA | Small, and keeps DNS and certificates with the client. |
| Ports from Windows to WSL | Bootstrap refreshes a `netsh portproxy` rule at every start; Windows Firewall allows only client subnets | Server 2022 has no mirrored networking and the WSL address changes on restart. |
| Secrets | Files under `/opt/alphaci/secrets` in WSL, root-only, read by Compose `env_file` | Entered by the client operator; never in images, manifests, or GitHub. |
| Example environments | `dev` (test) and `uat` use Vercel/Render; `main` (production) uses the client host | These names and source branches are editable for each new project. The laptop acts as production only for disposable lab projects. |
| App data | Named Docker volumes, backed up by the client's backup tool | The data belongs to the client's application. |

The environment routing above is the first client configuration, not a global
rule. Each project defines ordered environments and chooses a provider for each
environment and slot. Environments may share a source branch.

## How a release reaches the host

1. A push to the first project environment's source branch starts the release and deploys there. In this example, `dev` starts it on Vercel/Render. Pushes directly to `uat` or `main` may run quality checks but do not deploy. AlphaCI explicitly promotes the pinned release through `uat` to `main`; a branch PR, if used, is a separate code-governance step.
2. The package stage builds the frontend and backend OCI images once, scans them (block CRITICAL/HIGH), pushes them to GHCR, and records their digests. Render and this host deploy those same digests. Vercel test/UAT targets instead build from the pinned source commit and record separate deployment IDs.
3. The reusable `sign-release.yml` workflow writes the release manifest (image digests, release ID, environment ID, source commit), signs it with the KMS key, and registers it with the AlphaCI releases API using the project's AlphaCI token.
4. `alphaci-agent` on the host polls the API, downloads the manifest and signature, verifies them with the pinned public key, pulls each image by digest, runs `docker compose up -d`, checks health, and reports the result.
5. If health fails, the agent restores the previous manifest and reports the failure.

## 0. Test lane: our Windows 11 laptop

Host: the developer laptop's `Ubuntu` WSL distro, reserved for this test.
Checked on 2026-09-25: Ubuntu 26.04.1 LTS, WSL 2.7.12, systemd on, 16 cores
and about 7 GB of memory visible to WSL. Docker Engine is installed in Ubuntu:
`docker info` reports Ubuntu, `systemctl` reports Docker active, Compose and
Buildx respond, and `hello-world` runs. Bash, curl, jq, OpenSSL, and coreutils are installed. The
`/opt/alphaci` directories exist, with `secrets/` owned by root at mode 700;
the trust, TLS, and secret files are still pending.

1. Docker Desktop, Settings, Resources, WSL integration: turn **off** `Ubuntu` and apply. Desktop keeps serving the other distros for development.
2. In Ubuntu, check `command -v docker`. After Engine installation it must resolve to `/usr/bin/docker`; `docker info --format '{{.OperatingSystem}}'` must report Ubuntu. Before Engine installation, a path under `/mnt/c/Program Files/Docker/...` can appear because WSL inherits the Windows PATH; this alone does not mean Desktop integration is enabled.
3. Optional for this dedicated test distro: add `[interop]` and `appendWindowsPath=false` to `/etc/wsl.conf`, preserving `[boot] systemd=true` and `[user] default=anton`. Then run `wsl --terminate Ubuntu` in PowerShell and reopen it. The native Engine already works without this setting; it only removes Windows executables from Ubuntu's command search path.
4. Install Docker Engine and the Compose and Buildx plugins from [Docker's Ubuntu apt repository](https://docs.docker.com/engine/install/ubuntu/). Docker's official packages support Ubuntu 26.04 (`resolute`). Remove any conflicting Ubuntu Docker packages first, as the Docker instructions describe. Do not use the `docker.io` fallback.
5. Run `sudo systemctl enable --now docker`. Verify with `sudo docker info --format '{{.OperatingSystem}}'`, `docker compose version`, `docker buildx version`, and `sudo docker run --rm hello-world`. The operating system must be Ubuntu, not Docker Desktop.
6. Install the agent dependencies in WSL: `apt-get install bash curl jq openssl coreutils`. Create `/opt/alphaci/{bin,trust,secrets,tls,releases}` and restrict `secrets/` to root. Add the test trust, TLS, and secret files from section 3.
7. Keep WSL's default NAT networking (do not set `networkingMode=mirrored`), so the laptop behaves like Server 2022.
8. Register the laptop as the production environment's target for disposable React and .NET lab projects after the planned provider and agent exist. In the example template, this environment is named `main`; `dev` and `uat` stay on Vercel and Render. Do not point a client's production project at the laptop.
9. Run the acceptance checks in section 4 after the planned release workflow and agent exist. For the reboot check, restart Windows and sign in; on the laptop the scheduled task may run as your user, only when signed in.

The laptop lane proves the pipeline, signing, pulling, Compose, rollback, and
reboot recovery. It does not prove Server 2022 networking, client proxies and
certificate inspection, nested virtualization, or uptime. Next rung: one
Windows Server 2022 VM with nested virtualization, then the first client.

## 1. Client prerequisites (send before the visit)

- **Host:** Windows Server 2022 x64, 4 vCPU, 16 GB RAM, 100 GB SSD free, local administrator access for the install.
- **Virtualization:** if the server is a VM, nested virtualization on. Hyper-V: `Set-VMProcessor -VMName <vm> -ExposeVirtualizationExtensions $true`. VMware: "Expose hardware assisted virtualization to the guest OS".
- **Outbound HTTPS (443) allowed** from the host to: `ghcr.io`, `pkg-containers.githubusercontent.com`, the AlphaCI API host, `download.docker.com`, `archive.ubuntu.com`, `security.ubuntu.com`. During install only: `github.com` and `objects.githubusercontent.com` (WSL and distro downloads). Tell us about any proxy or TLS inspection.
- **Inbound:** only the application port (443) from the client's user subnets.
- **DNS and TLS:** a hostname per environment and a certificate plus key (or internal CA) for it.
- **People:** a Windows administrator for the install, and an operator who will enter application secrets.
- **Service account:** a local or domain account, for example `alphaci-svc`, that owns the WSL distro and runs the scheduled task.

## 2. AlphaCI side (before the visit)

1. Define each project's ordered environments, source branches, and sole production role. Assign one provider per environment and slot. In the example, configure `dev` and `uat` frontend targets on Vercel and backend targets on Render, then assign both `main` slots to `onprem-compose` with this production host ID. Record the stable environment and target IDs; do not use a branch name as their identity.
2. Create the corresponding GitHub Environments and protection rules before generated workflows can reference them. Confirm the repository plan supports the required rules; use AlphaCI's explicit promotion authorization as the deployment gate where GitHub required reviewers are unavailable.
3. Issue a host token for the agent (scoped to that host ID; outbound polling and status only).
4. Create a GHCR read token for the client's packages (`read:packages` only, on a machine account). Rotate every 90 days.
5. Export the configured P-256 signing public key: `gcloud kms keys versions get-public-key <version> --key=<key> --keyring=<ring> --location=<location> --project=<project> --output-file=alphaci.pub`. Configure `ALPHACI_RELEASE_TRUST_KEYS_JSON` on the backend with the exact KMS key-version resource name mapped to that PEM. The host pins the same PEM using `ALPHACI_TRUST_KEY`. A lab signer instead uses the public-key DER SHA-256 fingerprint as its `sha256:<hex>` key ID.
6. Confirm AlphaCI has an explicitly promoted, signed production release for this host, with the approved source commit and image digests.

## 3. On the client host

Run as administrator in PowerShell unless a step says WSL.

1. `wsl --install --no-distribution`, then restart Windows.
2. Sign in as `alphaci-svc` and run `wsl --install -d Ubuntu-24.04`. Create the Linux user when asked.
3. Limit WSL resources in `C:\Users\alphaci-svc\.wslconfig`:

   ```ini
   [wsl2]
   memory=8GB
   processors=4
   ```

4. WSL: put `[boot]` and `systemd=true` in `/etc/wsl.conf`; then in PowerShell `wsl --shutdown`.
5. Keep all data on the Linux filesystem (`/opt/alphaci`, Docker volumes). Never use `/mnt/c`; it is much slower and breaks file permissions.
6. WSL: install Docker Engine from Docker's apt repository (add the key to `/etc/apt/keyrings/docker.asc`, add the repository, then `apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`), and `systemctl enable --now docker`.
7. WSL: create `/opt/alphaci/{bin,trust,secrets,tls,releases}`. Copy `alphaci.pub` to `trust/` and the certificate and key to `tls/`. Set `secrets/` to `chmod 700` and every file in it to `chmod 600`, owned by root.
8. WSL: write `secrets/ghcr-token` and `secrets/host-token`, then `docker login ghcr.io -u <machine-account> --password-stdin < /opt/alphaci/secrets/ghcr-token`.
9. WSL: the client operator writes one `secrets/<app>.env` per application (connection strings, API keys).
10. WSL: run the checked-out `deploy/onprem/agent/install.sh` as root. Configure `/opt/alphaci/agent.env` with the API URL, token path, pinned public key, Compose file and project, state directory, and health URL. Copy and adapt the examples under `deploy/onprem/compose`; keep application secrets in root-owned files.
11. WSL: run `systemctl start alphaci-agent.service`, inspect its journal, and confirm `alphaci-agent.timer` is enabled. The timer polls outbound; the service is a oneshot operation.
12. Windows administrator: run `Install-AlphaCIHost.ps1 -Distro Ubuntu-24.04 -ServiceAccount CONTOSO\alphaci-svc -ClientSubnets 10.20.0.0/16` from `deploy/onprem/windows`. Use the actual account that owns the distro and the actual client subnet. The script installs the startup keepalive task, port-forward refresh task, and scoped firewall rules; it does not install the distro or agent. For the test laptop only, `-OnlyWhenSignedIn` avoids storing account credentials but does not prove unattended startup.
13. Confirm port forwarding and TLS from a client machine, then perform the reboot acceptance check. PowerShell bootstrap execution on this laptop has not been verified.

## 4. Acceptance checks

- [ ] A push to `dev` deploys only to the example test environment: frontend on Vercel and backend on Render. It does not reach UAT or the client host.
- [ ] Explicit promotion deploys the pinned source commit to UAT on Vercel/Render, then the same GHCR image digests to the production host. AlphaCI records each Vercel deployment ID and reports the host release as "healthy".
- [ ] If two environments share a source branch, a push deploys only to the project's first environment; promoting to the second requires a separate authorized action. A direct push to a later environment's unique branch also does not deploy it.
- [ ] The app answers on `https://<hostname>` from a client machine, with the client's certificate.
- [ ] A tampered manifest (edit one digest) is rejected and nothing restarts.
- [ ] A release whose health check fails rolls back to the previous release.
- [ ] After a Windows restart, the apps come back without anyone signing in.
- [ ] Regenerate environment workflows after changing managed target IDs; a stale promotion workflow must refuse deployment. Automatic regeneration on provider replacement remains a follow-up.
- [ ] No GitHub secret, pipeline, or AlphaCI record contains a host password, SSH key, or application secret.

## 5. Day-2 operations

- **Upgrade:** push to the configured source branch, pass its first environment, then explicitly promote that pinned release to production; the agent applies the approved manifest.
- **Rollback:** a failed health check automatically restores the previous local release. Operator-selected rollback and arbitrary earlier-release promotion remain follow-ups; the current promotion API requires the preceding environment to run the selected release.
- **Rotate:** GHCR token every 90 days (`docker login` again); agent token from AlphaCI; certificates before expiry (replace files, `docker compose restart caddy`).
- **Signing key rotation:** add the new key ID and PEM to the backend trust map, then coordinate replacement of the host's pinned PEM with the signing cutover. The current host has one pinned key, so verify the rollback implications before removing the previous key.
- **Support bundle:** `alphaci-agent support-bundle` collects agent logs, `docker compose ps`, recent container logs, and the current manifest, without secrets.
- **Uninstall:** export and verify a backup of application data, disable the scheduled task, remove the portproxy and firewall rules, then `docker compose down`. Run `wsl --unregister Ubuntu-24.04` only after the client approves permanent deletion of all data in that distro.

## 6. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `wsl --install` fails with a virtualization error | Nested virtualization off, or virtualization disabled in firmware | Section 1, virtualization |
| Apps stop a few seconds after sign-out | Scheduled task not running as `alphaci-svc`, or not set to run while signed out | Task Scheduler history |
| App unreachable from other machines, fine inside WSL | Stale portproxy address or firewall rule | `netsh interface portproxy show all`, then compare with `hostname -I` |
| Image pull fails with unauthorized | GHCR token expired or wrong scope | `docker login ghcr.io` again |
| Image pull times out | Proxy or egress rule blocks `pkg-containers.githubusercontent.com` | `curl -I https://ghcr.io` from WSL |
| Release rejected: signature invalid | Wrong or missing public key, or the key was rotated | Files in `/opt/alphaci/trust` |
| Agent never picks up releases | Agent token revoked, or API host blocked | Agent log; `curl -I <api-url>` from WSL |

## 7. Switching between managed and on-prem

The deployment target is selected per project, environment ID, and slot. The
example uses Vercel and Render for environments named `dev` and `uat`, then
`onprem-compose` for the production environment named `main`. Other projects
may use different names, source branches, order, and provider assignments.
Changing one target's provider regenerates its package and deploy jobs without
silently changing other environments. Quality gates stay shared; the host
keeps its last release until another approved release or uninstall.
