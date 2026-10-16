---
type: "Playbook"
title: "On-prem host setup"
description: "Set up a Windows or Ubuntu machine as an AlphaCI on-prem production host, from a fresh install to a verified release."
tags: [runbook, runtime, deployment, on-prem]
status: stable
sources:
  - id: agent
    resource: "deploy/onprem/agent"
    title: "Host agent, installer, and systemd units"
  - id: compose
    resource: "deploy/onprem/compose"
    title: "Example Compose stack and Caddyfile"
  - id: windows
    resource: "deploy/onprem/windows"
    title: "Windows and WSL startup scripts"
  - id: release-registry
    resource: "/architecture/release-registry.md"
    title: "Release registry contract"
  - id: client-guide
    resource: "/superpowers/plans/2026-09-25-onprem-client-setup-guide.md"
    title: "Client host acceptance procedure"
---
# On-prem host setup

## Enroll a reusable machine

Use the workspace **Hosts** screen for the machine workflow. Set a public HTTPS
`PLATFORM_PUBLIC_URL`, enable `ONPREM_RELEASES_ENABLED`, configure P-256 public
`ALPHACI_RELEASE_TRUST_KEYS_JSON`, apply the three `20261015` Runtime migrations,
and configure the installer version, URL, hash, and local archive path described
in the release registry contract. Keep the signing key in Cloud KMS (or, for lab
hosts only, in CI's secret store). It never belongs on an enrolled machine.

1. Build the preview package with `node scripts/package-onprem-agent.mjs`.
2. Choose Add host and copy the checksum-verifying installation command for the
   chosen platform. Paste the one-time code only at the installer's hidden prompt.
3. On Ubuntu, install Docker Engine/Compose, curl, jq, OpenSSL, flock,
   ca-certificates, and iproute2 first. Enable systemd and leave at least 1 GiB
   free. The installer checks these prerequisites and keeps existing Docker configuration.
4. On Windows, run as the account owning the Ubuntu WSL2 distro, in administrator
   PowerShell. The installer saves a non-secret installation ID and phase. If
   Windows features require a restart, restart and rerun the same command.
   It reports missing distro, WSL2, systemd, and Ubuntu prerequisites explicitly.
5. Enrollment writes protected host-local credential and public trust files.
   A saved, root-only response lets an interrupted configuration resume without
   another consumption. If the network response itself was lost, issue a new
   enrollment. A changed API URL requires explicit replacement. Reinstall does
   not rotate credentials. The timer starts only after a successful authenticated heartbeat.
6. Wait for Connected, then explicitly assign environments from Hosting. Set
   container ports and health paths for the actual application. Choose different
   host ports for every environment sharing this machine. Production requires
   an existing HTTPS ingress. No reverse proxy or certificate is invented.

The Windows test command uses sign-in startup and example forwarded ports 8080,
8081, and 8082. Add other selected ports by rerunning the Windows installer with
`-Ports`, retaining the allowed client subnets. A client server uses its dedicated
WSL account's startup task instead. Windows restart recovery and client-network
ingress must be tested on that machine.

Each assignment uses `/opt/alphaci/assignments/<project UUID>/<environment UUID>`,
Compose project `ac-<environment UUID without dashes>`, separate network and
named data volumes, a local worker lock, release state, and logs. Only its actual
frontend/backend slots become services. Configure application data persistence
to match the application's needs; the generated default volume mounts at
`/var/lib/alphaci-data`. Registry login stays local to the host.

Inspect `journalctl -u alphaci-machine.service` and assignment `worker.log` files.
Run `/opt/alphaci/bin/alphaci-supervisor support-bundle` for machine diagnostics.
The Windows export chooses the machine or legacy diagnostic path automatically.
Uninstall disables polling timers and removes Windows startup/network rules;
containers, credentials, and data remain until explicitly removed. Revoke access
in AlphaCI too. Unassign/revoke cannot cancel Docker commands already executing.
Separate machines are required for mutually untrusted workloads.

The remainder of this runbook describes the retained legacy registration path.

This runbook takes a fresh Windows PC to a running AlphaCI production host. The
first project in it is a single backend service: its Test environment deploys
to Render, and its Production environment deploys to the host.

The host only makes outbound calls. The agent polls AlphaCI every 30 seconds,
verifies each release signature against a pinned public key, pulls images from
GHCR by digest, starts them with Docker Compose, checks health, and reports the
result. A release that fails its health check is replaced by the previous one.

Run every AlphaCI action as an **admin**. A lead can promote to production but
cannot register a host.

| Need | Value |
|---|---|
| Host | Windows 10 22H2 or Windows 11 with virtualization on, or an Ubuntu 24.04 machine. 16 GB RAM is recommended. |
| Access | Administrator on the host; admin in AlphaCI; access to the backend hosting settings and the GitHub organization. |
| Outbound HTTPS | `ghcr.io`, `pkg-containers.githubusercontent.com`, the AlphaCI API host, `download.docker.com`, Ubuntu package mirrors. |
| Inbound | Port 443, only from the networks that use the apps. |

On an Ubuntu machine without Windows, skip steps 1–5 and Part 8.

## Part 1: Prepare the Windows PC

1. Open PowerShell as administrator: Start, type `PowerShell`, right-click, **Run as administrator**.
2. Install WSL with Ubuntu, then restart the PC when asked:

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

   A virtualization error means virtualization (Intel VT-x or AMD-V) is off in the BIOS.
3. After the restart, open **Ubuntu** from the Start menu and choose a Linux username and password. Commands marked **Ubuntu** run in this window.
4. **Ubuntu:** confirm systemd is on:

   ```bash
   systemctl is-system-running
   ```

   `running` or `degraded` is fine. If it fails, enable systemd, run `wsl --shutdown` in PowerShell, and reopen Ubuntu:

   ```bash
   sudo sh -c 'printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf'
   ```
5. **PowerShell:** run `ipconfig` and record the **IPv4 Address**, for example `192.168.1.50`. This runbook calls it `PC_IP`.

## Part 2: Install Docker and tools

6. **Ubuntu:** install the agent's tools:

   ```bash
   sudo apt-get update && sudo apt-get install -y ca-certificates curl jq openssl
   ```
7. **Ubuntu:** install Docker Engine from Docker's repository:

   ```bash
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
   sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   sudo systemctl enable --now docker
   ```

   Do not use Docker Desktop on a host. If it is installed, turn off its WSL integration for this distro.
8. **Ubuntu:** `sudo docker run --rm hello-world` must print "Hello from Docker!".

## Part 3: Install the agent

9. **Windows browser:** sign in to GitHub, open `github.com/Alpha-Explora/alphaci-golden-copy-be`, choose **Code**, **Download ZIP**, and extract it in Downloads.
10. **Ubuntu:** copy the on-prem folder. Replace `YOU` with the Windows username and adjust the folder name if the extract differs:

    ```bash
    cp -r "/mnt/c/Users/YOU/Downloads/alphaci-golden-copy-be-main/deploy/onprem" ~/onprem
    ls ~/onprem    # agent  compose  windows
    ```
11. **Ubuntu:** run the installer. It creates `/opt/alphaci`, installs `/opt/alphaci/bin/alphaci-agent`, and enables a 30-second timer:

    ```bash
    sudo bash ~/onprem/agent/install.sh
    ```

    The agent logs errors every 30 seconds until Part 7 is complete.

## Part 4: Set up release signing

Do this once for the whole AlphaCi deployment. Client hosts sign with Cloud KMS.
The local lab key in steps 12–15 is for lab hosts only. Either way, AlphaCi
configures each new on-prem project's signing itself (step 20).

### Cloud KMS (client hosts)

Use the AlphaCi release signing key in the client's Google Cloud project, as the
client setup guide describes. It is an ECDSA P-256 key that signs with
`EC_SIGN_P256_SHA256`. Its private key never leaves Cloud KMS.

Name the key version. This exact resource name is also the release key ID, and
its version must be a number:

```text
projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION
```

Export that version's public key:

```bash
gcloud kms keys versions get-public-key VERSION --key=KEY --keyring=RING --location=LOCATION --project=PROJECT --output-file=alphaci.pub
```

Build the backend trust setting. The key ID must be the resource name, exactly:

```bash
KMS_KEY_VERSION='projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION'
jq -nc --arg id "$KMS_KEY_VERSION" --rawfile pem alphaci.pub '{($id):$pem}'
```

The sign-release job signs as a separate **signer identity**. Use a Workload
Identity pool and GitHub provider for signing only. Do not reuse the Cloud Run
runtime pool (`GCP_WORKLOAD_IDENTITY_PROVIDER`). In Google Cloud:

- Grant the signer service account `roles/cloudkms.signerVerifier` on the key
  version or key, and nothing broader.
- Create the GitHub provider with issuer `https://token.actions.githubusercontent.com`,
  map `google.subject` to `assertion.sub` and `attribute.repository` to
  `assertion.repository`, and restrict it with an attribute condition to the
  client's organization.
- Let each project repository impersonate the signer. Grant
  `roles/iam.workloadIdentityUser` on the signer service account to
  `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/attribute.repository/OWNER/REPO`
  for every repository that signs. This grant is manual, one per repository, or
  one `attribute.repository_owner/OWNER` grant for the whole organization.

Keep the output of the trust command and the resource name for step 17, and pin
the same PEM on every host, as step 14 does: copy `alphaci.pub` to
`/opt/alphaci/trust/release-signing.pub.pem`.

Provisioning then sets the repository variable `ALPHACI_RELEASE_KMS_KEY_VERSION`
on each new project with an on-prem target in any environment (step 20), and
writes the signer identity into that project's sign-release job. Set the backend
values before the project is created. If they change later, regenerate the
project's workflows so the sign job carries the new identity.

### Lab key (lab hosts only)

12. **Ubuntu:** create the key pair:

    ```bash
    mkdir -p ~/alphaci-keys && cd ~/alphaci-keys
    openssl ecparam -name prime256v1 -genkey -noout -out release-signing.key
    openssl pkey -in release-signing.key -pubout -out release-signing.pub.pem
    ```
13. **Ubuntu:** print the backend trust setting and keep the one-line output for step 17:

    ```bash
    KEY_ID="sha256:$(openssl pkey -in release-signing.key -pubout -outform DER | sha256sum | cut -d' ' -f1)"
    jq -nc --arg id "$KEY_ID" --rawfile pem release-signing.pub.pem '{($id):$pem}'
    ```
14. **Ubuntu:** pin the public key on the host:

    ```bash
    sudo cp ~/alphaci-keys/release-signing.pub.pem /opt/alphaci/trust/release-signing.pub.pem
    ```
15. Store `release-signing.key` in the team password manager. Lab only: make the PEM readable by the backend process (on Render, a secret file mounts under `/etc/secrets/`), and set `ONPREM_LAB_SIGNING_KEY_PATH` to that path (step 17). Provisioning copies the key into the project secret `ALPHACI_RELEASE_SIGNING_KEY` (step 20). Cloud KMS wins when `ALPHACI_RELEASE_KMS_KEY_VERSION` is also set. Client hosts must not use this key.

## Part 5: Enable on-prem in AlphaCI

Do this once per AlphaCI deployment.

16. **Developer machine, backend repository:** point `SUPABASE_DB_URL` in `.env` at the deployed backend's database, then apply the migrations in this order, before the backend that needs them is running:

    ```bash
    git checkout main && git pull && npm ci
    npm run db:apply -- 20260925050000_project_environments.sql 20260928100000_deployment_target_environments.sql 20260928200000_release_registry.sql 20260928210000_onprem_compose_provider.sql 20261015010000_one_active_onprem_host.sql
    ```
17. **Backend hosting settings** (for example the Render service's Environment page): set these values, save, and redeploy:

    ```text
    ENV_PROVISIONING_ENABLED=true
    ONPREM_RELEASES_ENABLED=true
    ALPHACI_RELEASE_TRUST_KEYS_JSON=<the one-line trust JSON from Part 4>
    # Choose one signing source. Cloud KMS for client hosts:
    ALPHACI_RELEASE_KMS_KEY_VERSION=<the Cloud KMS key version from Part 4>
    ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER=<the signer provider from Part 4>
    ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT=<the signer service account from Part 4>
    # Lab hosts only, instead of the line above:
    # ONPREM_LAB_SIGNING_KEY_PATH=<path to release-signing.key from step 15>
    ```

## Part 6: Create the project

The setup wizard cannot yet give one environment a different provider, so this
step uses the API from the browser console while signed in.

18. **Browser:** open AlphaCI as an admin, press F12, open **Console**, and run:

    ```js
    const API = 'https://YOUR-BACKEND/api/v1';
    const get = (p) => fetch(API + p, { credentials: 'include' }).then(r => r.json());
    console.log(await get('/workspaces/me'));
    console.log(await get('/catalog/project-options'));
    ```

    Copy the team `id` and the id of the backend project type to use.
19. **Same console:** create the project. Test deploys to Render; Production deploys to the host:

    ```js
    const res = await fetch(API + '/projects', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoName: 'onprem-lab-api', visibility: 'private',
        projectTypeId: 'PROJECT_TYPE_ID', serviceName: 'api', workspaceId: 'TEAM_ID',
        environments: [
          { slug: 'dev',  displayName: 'Test',       sourceBranch: 'dev',  role: 'non_production' },
          { slug: 'main', displayName: 'Production', sourceBranch: 'main', role: 'production' },
        ],
        deploymentProvisioning: { enabled: true, targets: [
          { slot: 'backend', provider: 'render', ownershipMode: 'flowci_managed', projectName: 'onprem-lab-api' },
          { slot: 'backend', provider: 'onprem-compose', ownershipMode: 'byo', environmentSlug: 'main' },
        ]},
      }),
    });
    console.log(res.status, await res.json());
    ```

    Status `201` means the repository, environments, targets, and pipeline were created.
20. **AlphaCI configures signing when it creates the project, if any environment deploys to the host.** With Cloud KMS, it sets the repository variable `ALPHACI_RELEASE_KMS_KEY_VERSION` and writes the signer identity into the sign-release job. With the lab key (lab hosts only), it writes the lab key as the repository secret `ALPHACI_RELEASE_SIGNING_KEY`. Two things stay manual: the identity-pool grant for this repository (Part 4), and the fix named by any `releaseSigningWarning` in the step 19 response. Find the warning type and fix it as follows:
    - **Lab secret** (the warning names `ALPHACI_RELEASE_SIGNING_KEY`): the secret could not be written, or the lab key file could not be read or is not a P-256 key. Fix the path in `ONPREM_LAB_SIGNING_KEY_PATH` or the GitHub permission, then add the secret under **Settings**, **Secrets and variables**, **Actions**, **Secrets** with the full contents of `release-signing.key`, including the BEGIN and END lines.
    - **Lab trust** (the warning says the releases would not verify and that `ALPHACI_RELEASE_SIGNING_KEY` was not written): the lab key was not written, because its key ID is not in the trust setting. Add its key ID and public PEM to `ALPHACI_RELEASE_TRUST_KEYS_JSON`, as in Part 4, then add the secret under **Settings**, **Secrets and variables**, **Actions**, **Secrets** with the full contents of `release-signing.key`.
    - **KMS variable** (the warning names `ALPHACI_RELEASE_KMS_KEY_VERSION`): the variable could not be written, or the Cloud KMS settings in step 17 were incomplete. Complete the settings, regenerate this project's workflows so the sign-release job carries the signer identity, then add the variable under **Settings**, **Secrets and variables**, **Actions**, **Variables**.
    - **KMS trust** (the warning says the releases will not verify and names `ALPHACI_RELEASE_KMS_KEY_VERSION`): the variable was written, but `ALPHACI_RELEASE_TRUST_KEYS_JSON` does not contain that key version. Add the entry as in Part 4. No repository change is needed.
21. **AlphaCI:** open the project's **Hosting** tab. In the **Production** card, enter a host name such as `lab-pc` and choose **Register host**. Copy the token; it is shown once.

## Part 7: Configure the agent

Configure `ALPHACI_HEALTH_URL` in `/opt/alphaci/agent.env` with the application's
readiness URL reachable from Ubuntu. The URL must return 2xx after both a new
deployment and restoration of the previous release. For HTTPS, Ubuntu must
trust the certificate authority; accepting a browser certificate warning does
not configure curl's trust. If the setting is empty, the agent uses Compose's
wait result and any service healthchecks, without an application HTTP check.

22. **Ubuntu:** set the API URL and hostname:

    ```bash
    sudo sed -i 's|^ALPHACI_API_URL=.*|ALPHACI_API_URL=https://YOUR-BACKEND|; s|^ALPHACI_HOSTNAME=.*|ALPHACI_HOSTNAME=PC_IP|' /opt/alphaci/agent.env
    ```
23. **Ubuntu:** save the host token (paste it, then Ctrl+O, Enter, Ctrl+X):

    ```bash
    sudo nano /opt/alphaci/secrets/host-token
    sudo chmod 600 /opt/alphaci/secrets/host-token
    ```
24. **Ubuntu:** confirm AlphaCI accepts the token. The answer is `[]` until a release is promoted:

    ```bash
    curl -fsS -H "Authorization: Bearer $(sudo cat /opt/alphaci/secrets/host-token)" https://YOUR-BACKEND/api/v1/onprem/assignments
    ```
25. **Ubuntu:** let the host pull images. On GitHub, open **Settings**, **Developer settings**, **Tokens (classic)**, create a token with only `read:packages`, and authorize it for the organization if asked. Use it as the password:

    ```bash
    sudo docker login ghcr.io -u YOUR_GITHUB_USERNAME
    ```

    The login must use `sudo`, because the agent runs as root.
26. **Ubuntu:** write the Compose stack. Change `8080` to the port the application listens on:

    ```bash
    sudo tee /opt/alphaci/compose/compose.yaml > /dev/null <<'EOF'
    name: alphaci
    services:
      backend:
        image: ${ALPHACI_IMAGE_BACKEND:?the release has no backend image}
        restart: unless-stopped
        expose: ["8080"]
        env_file:
          - path: /opt/alphaci/secrets/backend.env
            required: false
      caddy:
        image: caddy:2.10-alpine
        restart: unless-stopped
        ports: ["443:443"]
        environment:
          ALPHACI_HOSTNAME: ${ALPHACI_HOSTNAME:?set ALPHACI_HOSTNAME}
        volumes:
          - ./Caddyfile:/etc/caddy/Caddyfile:ro
          - caddy-data:/data
        depends_on: [backend]
    volumes:
      caddy-data: {}
    EOF
    sudo tee /opt/alphaci/compose/Caddyfile > /dev/null <<'EOF'
    {$ALPHACI_HOSTNAME}:443 {
    	tls internal
    	reverse_proxy backend:8080
    }
    EOF
    ```

    Application secrets go in `/opt/alphaci/secrets/backend.env`, one `NAME=value` per line. For a frontend and backend together, start from `/opt/alphaci/compose/compose.example.yaml` and `Caddyfile.example` instead. With a real certificate, put `cert.pem` and `key.pem` in `/opt/alphaci/tls` and use the example's `tls` line.

## Part 8: Start at boot and open the port

27. **PowerShell as administrator:** run the Windows bootstrap from the extracted download:

    ```powershell
    cd $env:USERPROFILE\Downloads\alphaci-golden-copy-be-main\deploy\onprem\windows
    powershell -ExecutionPolicy Bypass -File .\Install-AlphaCIHost.ps1 -Distro Ubuntu-24.04 -ClientSubnets LocalSubnet -OnlyWhenSignedIn
    ```

    It installs a task that keeps Ubuntu running, a task that forwards port 443 to Ubuntu's changing address, and a firewall rule for the listed networks. It ends by printing the forwarding rule.

    `-OnlyWhenSignedIn` suits a test PC: the apps run while someone is signed in, and no password is stored. On a server, use a service account so the apps start at boot without a sign-in, and name the client networks:

    ```powershell
    powershell -ExecutionPolicy Bypass -File .\Install-AlphaCIHost.ps1 -Distro Ubuntu-24.04 -ServiceAccount DOMAIN\alphaci-svc -ClientSubnets 10.20.0.0/16
    ```

## Part 9: Deploy and verify

28. Push any commit to the project's `dev` branch. Releases from before step 20 failed at signing. In the repository's **Actions** tab, the package workflow builds the image, signs the release, and deploys Test to Render.
29. **AlphaCI, Hosting, Production card:** choose **Promote … from Test**, then confirm.
30. **Ubuntu:** watch the agent pick it up within about 30 seconds:

    ```bash
    journalctl -u alphaci-agent.service -f
    ```

    Expect the release to be pulled and started, then `deployment … healthy`. The Production card shows the release as healthy.
31. **Another computer on the network:** open `https://PC_IP`. Accept the certificate warning that `tls internal` causes; the application loads.
32. Restart the PC and sign in. Within about a minute, `https://PC_IP` works again.

## Adding another host

Each environment has one active host token. Registering a replacement revokes
all previous host tokens for that environment. Stop the old agent before
replacement; revoking a token cannot stop a deployment already running there.
For a new machine, repeat Parts 1–3, copy
`release-signing.pub.pem` to `/opt/alphaci/trust/` (step 14), skip Parts 4 and 5,
register the host in the environment's card (step 21), then follow Parts 7–9.

## Adding another project

Repeat steps 18–21 with the new repository name. Grant the new repository access
to the signer identity first (Part 4). Signing is then configured automatically
(step 20). A host serves one environment; a second project's production needs its own host or its own
Compose project and agent configuration.

An on-prem target added to a project that already exists is refused until its
repository can sign releases. Set the Cloud KMS settings on the backend (step 17),
regenerate the project's workflows so the sign-release job carries the signer
identity, and then add the target again. AlphaCI writes the repository variable
when it accepts the target. A trust gap refuses the target before anything is
written. It cannot see the pipeline's contents from there, so
the regeneration step is yours to do.

## Rotate the Cloud KMS signing key

A new key version does not change the signer identity, so the sign-release job
keeps working. It reads the repository variable at run time. Rotate in this order:

1. Create the new key version and export its public PEM, as in Part 4.
2. Backend: set `ALPHACI_RELEASE_KMS_KEY_VERSION` to the new resource name, and add
   the new name to `ALPHACI_RELEASE_TRUST_KEYS_JSON`. Keep the old entry until no
   release signed with the old key can still be promoted or deployed.
3. Each on-prem project's repository: under **Settings**, **Secrets and variables**,
   **Actions**, **Variables**, change `ALPHACI_RELEASE_KMS_KEY_VERSION` to the new
   name. Existing repositories keep the old value, because provisioning runs only
   when a project is created.
4. Each host: the agent verifies with one pinned PEM. Pin the new PEM at
   `/opt/alphaci/trust/release-signing.pub.pem` before the next release signed with
   the new key is promoted to that host, and promote no older release after that.

Regenerate workflows only when the signer identity itself changes.

## Troubleshooting

| Symptom | Check |
|---|---|
| Step 24 returns 401 | The token was copied incompletely, or the host was registered on another environment. Register a new host. |
| Step 24 returns 503 | `ONPREM_RELEASES_ENABLED` or `ENV_PROVISIONING_ENABLED` is not `true` on the deployed backend. |
| Readiness shows `release-signing` failed | Cloud KMS needs `ALPHACI_RELEASE_KMS_KEY_VERSION` and both signer settings, and the trust JSON must contain that exact key version. For lab hosts, `ONPREM_LAB_SIGNING_KEY_PATH` must be readable and its key ID trusted. |
| The sign-release job fails | At **Authenticate to Google Cloud**: the generated workflow lacks the signer identity (regenerate after fixing the backend), or the identity pool does not allow this repository (Part 4). At signing: the repository variable `ALPHACI_RELEASE_KMS_KEY_VERSION` is missing (or, lab only, the `ALPHACI_RELEASE_SIGNING_KEY` secret). The step 19 response would have said so in `releaseSigningWarning`. Or the trust JSON lacks the key ID: for Cloud KMS, the exact key-version name; for the lab key, the ID from step 13. |
| No **Promote** button on Production | Test has not reported a healthy release yet, or the account is not an admin or lead. |
| Promotion stays pending | The agent is not polling. Run `systemctl list-timers alphaci-agent.timer` and `journalctl -u alphaci-agent.service -n 50`. |
| Deployment failed: signature, hash, or project rejected | The host's `release-signing.pub.pem` does not match the key that signed the release. |
| Deployment failed: image could not be pulled | Repeat step 25 with `sudo`, and confirm the token has `read:packages` and organization authorization. |
| Deployment rolled back | The new release failed to start or its health check. Run `sudo docker compose -p alphaci logs --tail 200`. |
| Previous release restored but deployment reports failed | The restored Compose services or the configured `ALPHACI_HEALTH_URL` failed the health check. Check the application logs and endpoint. |
| Works on the PC but not from other machines | Run `netsh interface portproxy show v4tov4` in PowerShell and confirm the **AlphaCI TCP 443** firewall rule allows the caller's network. |
| Stops after sign-out or reboot | The startup task runs only while signed in. Re-run step 27 with `-ServiceAccount`. |

For anything else, run `sudo /opt/alphaci/bin/alphaci-agent support-bundle`. It
writes an archive of agent logs, Compose state, and the running release to
`/opt/alphaci/support`. The archive never contains the host token, but it does
contain application logs; review it before sending.

For an on-prem first environment, generated package workflows report signing
failure or cancellation to release its pending deployment. Regenerate existing
project workflows to install the cleanup job. CI can fail only an unsigned,
pending host deployment; a signed release remains the host's responsibility.
If workflow cleanup could not run, a project CI token can report `failed` to
`POST /api/v1/ci/releases/<release-id>/deployment-status` with
`{"repoFullName":"owner/repo","status":"failed","detail":"Signing did not complete."}`.
The API rejects a late signature after cleanup. A retry must register a release
from a new workflow run.

## Removing a host

1. **PowerShell as administrator,** in `deploy\onprem\windows`: remove the tasks, port forwarding, and firewall rules. Ubuntu and its data stay.

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Uninstall-AlphaCIHost.ps1
   ```
2. **Ubuntu:** stop the agent and the applications:

   ```bash
   sudo systemctl disable --now alphaci-agent.timer
   sudo docker compose -p alphaci -f /opt/alphaci/compose/compose.yaml down
   ```
3. Back up application data before deleting anything. `wsl --unregister Ubuntu-24.04` deletes the whole distro and everything in it.
