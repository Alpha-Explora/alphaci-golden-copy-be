# On-prem client setup guide (onprem-compose)

How to set up a customer-hosted deployment target for a client's React and
.NET projects, from the test laptop to an enterprise Windows server.

**Status:** target procedure. The host bootstrap (`Install-AlphaCIHost.ps1`),
the host agent (`alphaci-agent`), the `onprem-compose` provider, and the
on-prem workflows are built by the
[configurable deployment targets plan](2026-09-25-configurable-deployment-targets.md).
Names marked *proposed* do not exist yet. Run section 0 before any client.

## Chosen defaults

| Decision | Choice | Why |
|---|---|---|
| First workload | Customer React and .NET projects | Chosen by the product owner. AlphaCI itself stays on managed hosting. |
| Delivery path | `onprem-compose`: Windows + WSL2 Ubuntu + Docker Engine + Compose | Most first clients have one Windows server and no cluster. Kubernetes (`onprem-k8s`) comes later, for clients that already run it. |
| Connectivity | Connected: the host pulls from GHCR | Chosen by the product owner. Air-gapped bundles are a later tier. |
| Windows targets | Test: Windows 11 (our laptop). Clients: Windows Server 2022 | Server 2022 is the common enterprise baseline and supports WSL2. Add Server 2025 after the same checks pass. |
| Client host distro | Ubuntu 24.04 LTS | Docker publishes official Engine packages for it. |
| Container runtime | Docker Engine inside WSL (not Docker Desktop) | No GUI, licence, or signed-in user dependency on a server. |
| Signing | Cosign with an AlphaCI-owned key in Google Cloud KMS; hosts get only the public key | The private key never leaves KMS. Signing skips the public transparency log so hosts verify without reaching sigstore.dev. |
| Desired state | The host agent polls the AlphaCI releases API for the approved release, then pulls images from GHCR by digest | Outbound only. AlphaCI never connects into the client network. |
| Status | Agent reports outbound to AlphaCI; if blocked, an operator exports a support bundle | Client firewalls usually block inbound traffic. |
| Ingress and TLS | Caddy container in the Compose stack, using the client's certificate or internal CA | Small, and keeps DNS and certificates with the client. |
| Ports from Windows to WSL | Bootstrap refreshes a `netsh portproxy` rule at every start; Windows Firewall allows only client subnets | Server 2022 has no mirrored networking and the WSL address changes on restart. |
| Secrets | Files under `/opt/alphaci/secrets` in WSL, root-only, read by Compose `env_file` | Entered by the client operator; never in images, manifests, or GitHub. |
| Environments | Separate hosts for `uat` and `main` | A test on `uat` cannot take production down. The test laptop runs `uat` only. |
| App data | Named Docker volumes, backed up by the client's backup tool | The data belongs to the client's application. |

## How a release reaches the host

1. A push to `uat` or `main` runs the generated pipeline (`00` access to `30` verify). Quality and build are the stack's usual jobs.
2. The package stage builds the image, scans it (block CRITICAL/HIGH), pushes it to GHCR, and records the digest.
3. *Proposed* `onprem-release-publish.yml` writes the release manifest (image digests, release id, environment), signs it with the KMS key, and registers it with the AlphaCI releases API using the project's AlphaCI token.
4. `alphaci-agent` on the host polls the API, downloads the manifest and signature, verifies them with the pinned public key, pulls each image by digest, runs `docker compose up -d`, checks health, and reports the result.
5. If health fails, the agent restores the previous manifest and reports the failure.

## 0. Test lane: our Windows 11 laptop

Host: the developer laptop's `Ubuntu` WSL distro, reserved for this test.
Checked on 2026-09-25: Ubuntu 26.04 LTS, WSL 2.7.12, systemd on, 16 cores and
about 7 GB of memory visible to WSL. The `docker` command in it was Docker
Desktop's CLI through WSL integration; no Engine was installed in the distro.

1. Docker Desktop, Settings, Resources, WSL integration: turn **off** `Ubuntu` and apply. Desktop keeps serving the other distros for development.
2. In `Ubuntu`, run `. /etc/os-release; echo $VERSION_CODENAME`. If `https://download.docker.com/linux/ubuntu/dists/` lists that codename, install from Docker's repository (section 3, step 6). If not, use Ubuntu's packages for the test: `sudo apt-get install -y docker.io docker-compose-v2`.
3. `sudo systemctl enable --now docker`, then `docker info --format '{{.OperatingSystem}}'` must print Ubuntu, not Docker Desktop.
4. Keep WSL's default NAT networking (do not set `networkingMode=mirrored`), so the laptop behaves like Server 2022.
5. Create `/opt/alphaci` and the files from section 3, steps 7 to 9, with test values.
6. Register the laptop as the `uat` target of one React and one .NET test project in AlphaCI. Leave `main` on Vercel and Render.
7. Run the acceptance checks in section 4. For the reboot check, restart Windows and sign in; on the laptop the scheduled task may run as your user, only when signed in.

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

1. Create a deployment target for each environment: provider `onprem-compose`, slot, branch, and a host id.
2. Issue a host token for the agent (scoped to that host id; outbound polling and status only).
3. Create a GHCR read token for the client's packages (`read:packages` only, on a machine account). Rotate every 90 days.
4. Export the signing public key: `cosign public-key --key gcpkms://projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k> > alphaci.pub`.
5. Confirm the project's latest `uat` pipeline produced a signed release.

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
8. WSL: write `secrets/ghcr-token` and `secrets/agent-token`, then `docker login ghcr.io -u <machine-account> --password-stdin < /opt/alphaci/secrets/ghcr-token`.
9. WSL: the client operator writes one `secrets/<app>.env` per application (connection strings, API keys).
10. *Proposed:* run `Install-AlphaCIHost.ps1 -HostId <id> -ApiUrl <url> -Distro Ubuntu-24.04 -ServiceAccount alphaci-svc`. It is safe to rerun and does steps 11 to 13.
11. Scheduled task at startup, as `alphaci-svc`, "run whether the user is signed in or not", restart on failure: `wsl.exe -d Ubuntu-24.04 -u root -- /opt/alphaci/bin/alphaci-agent run`. The long-running agent keeps the WSL instance alive; a task running as SYSTEM cannot see the service account's distro.
12. Port forward, refreshed at every start because the WSL address changes: read the address with `wsl -d Ubuntu-24.04 hostname -I`, then `netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=443 connectaddress=<wsl-ip>` (delete the old rule first).
13. Firewall: `New-NetFirewallRule -DisplayName "AlphaCI HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -RemoteAddress <client-subnets> -Action Allow`.

## 4. Acceptance checks

- [ ] A push to `uat` deploys both apps; the AlphaCI release page shows the digests and "healthy".
- [ ] The app answers on `https://<hostname>` from a client machine, with the client's certificate.
- [ ] A tampered manifest (edit one digest) is rejected and nothing restarts.
- [ ] A release whose health check fails rolls back to the previous release.
- [ ] After a Windows restart, the apps come back without anyone signing in.
- [ ] Switching the target to Vercel or Render in AlphaCI and pushing again deploys there, with no pipeline edits by hand.
- [ ] No GitHub secret, pipeline, or AlphaCI record contains a host password, SSH key, or application secret.

## 5. Day-2 operations

- **Upgrade:** push to the branch; the agent applies the new approved release.
- **Rollback:** approve an earlier release in AlphaCI, or on the host run *proposed* `alphaci-agent rollback`.
- **Rotate:** GHCR token every 90 days (`docker login` again); agent token from AlphaCI; certificates before expiry (replace files, `docker compose restart caddy`).
- **Signing key rotation:** add the new public key to `trust/` on every host before signing with it; remove the old key after the last old release is retired.
- **Support bundle:** *proposed* `alphaci-agent support-bundle` collects agent logs, `docker compose ps`, recent container logs, and the current manifest, without secrets.
- **Uninstall:** disable the scheduled task, remove the portproxy and firewall rules, `docker compose down`, then `wsl --unregister Ubuntu-24.04` (this deletes all data in the distro).

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

The deployment target is a setting on each project environment. Changing a
target's provider between `vercel`, `render`, `gcp`, and `onprem-compose`
regenerates the deploy step on the next push. Quality and build jobs do not
change, and the host keeps its last release until it is uninstalled.
