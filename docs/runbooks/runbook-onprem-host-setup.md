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
2. Choose Add host and either download the install file for the chosen platform
   (it already carries the one-time code: run it once, then delete it), or copy
   the checksum-verifying installation command and paste the code only at the
   installer's hidden prompt.
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
   enrollment. Reinstall does not rotate credentials: a replacement code from
   Hosting is consumed only with `install.sh --enroll <API URL> --replace`
   (Windows: `-ReplaceCredential`), which sets the current credential aside and
   restores it if the code is not accepted. A changed API URL also requires
   replacement. The timer starts once enrollment succeeds; the first authenticated
   check-in runs before it, and if that check-in fails the timer keeps retrying.
6. Wait for Connected. While it is the workspace's only connected machine,
   new non-production on-prem environments are assigned to it automatically
   (container port 3000 for a frontend, 4000 for a backend, health at `/`);
   adjust them from Hosting if the application differs. With several connected
   machines, Hosting asks which one to use. AlphaCI picks each host port
   (from 8080 upward, distinct per machine). Production needs an HTTPS address,
   so it is assigned from Hosting: either an existing HTTPS ingress URL, or the
   automatic HTTPS address described below. No reverse proxy or certificate is
   invented.
7. To retire a machine, enroll its replacement with a replacement code (or
   revoke it naming the replacement): its environments move to the new
   machine with the same host ports where they are free. Revoking without a
   replacement ends those environments' bindings and releases their host ports.
   The environments then have no host until you assign them from Hosting; no
   Unassign is needed. Automatic assignment runs only when an environment is
   provisioned, or when a target is created or attached to it, not after a
   revocation. Revoking also ends the machine's pending replacement enrollment,
   so that code stops working. To keep the environments on the replacement,
   consume its enrollment before revoking.

## Automatic HTTPS address (tunnel)

Choose **Automatic HTTPS address (tunnel)** for "How users reach it" in Hosting
(or in the create wizard) when the machine has no DNS name or certificate. The
machine then runs a Cloudflare quick tunnel from the environment's frontend host
port to the internet and reports its `https://<words>-<words>.trycloudflare.com`
address to AlphaCI with each check-in. Hosting shows the address under "Reached
at", and the frontend target's address becomes that link.

Production waits for the tunnel. Until a running tunnel reports its address,
AlphaCI does not hand production releases to the machine, and Hosting says
"Waiting for the HTTPS address." Other environments deploy without waiting, and
their readiness says "Waiting for the machine to report its address."

Requirements on the machine:

- An agent of version 0.3.0 or newer. Readiness asks for an update otherwise.
- `cloudflared` 2026.10.0 or newer on the `PATH` of root (`command -v cloudflared`
  must succeed, and `cloudflared --version` must print a version). 2026.10.0 is
  the release AlphaCI was tested with, and the agent refuses older releases.
  An older or missing binary is reported as a plain message in Hosting; nothing
  else on the machine is affected. When a newer release is tested, the agent's
  minimum version is raised in `deploy/onprem/agent/tunnel.sh`.
- Outbound HTTPS only. The tunnel makes outbound connections; no inbound port opens.
- The environment's Compose stack must answer on its host port. The tunnel forwards
  to it whether or not a release is healthy, so check the application separately.

Each tunnel is its own systemd unit, `alphaci-tunnel@<environment UUID>.service`,
configured by `/opt/alphaci/tunnels/<environment UUID>/tunnel.env`. It runs as the
unprivileged user `alphaci-tunnel`. It can write only its `run/` subdirectory; the
directory that holds its settings is root-owned, so the unit cannot replace them. It runs with
no new privileges, no capabilities, and IPv4/IPv6 sockets only. systemd keeps
it running and restarts it after 15 seconds if it stops. The supervisor starts
the unit when an assignment uses tunnel mode and stops it when the assignment
leaves the machine. The unit runs with an empty cloudflared config, so a
`~/.cloudflared/config.yml` on the machine cannot change the quick tunnel.

Logs are in the journal, not in files:

    journalctl -u 'alphaci-tunnel@*' -n 200 --no-pager

The support bundle (`alphaci-supervisor support-bundle`) includes the same output.
AlphaCI only reports addresses that match the quick-tunnel form. An address of
any other host, such as `api.trycloudflare.com` or an IP address, is not reported.

**A quick-tunnel address changes when the tunnel restarts.** A restart happens
after a machine reboot, after cloudflared exits, or after the assignment's port
changes. The old address stops working, and the new one appears on the next
check-in, about a minute later. Tell users, and update any link, bookmark,
webhook, or OAuth redirect that uses it. Cloudflare documents quick tunnels for
testing, not as a service level.

Stopping tunnels:

- A machine that is revoked, or whose credential is rejected at check-in, stops
  every tunnel at its next check-in.
- Linux uninstall: run `sudo ./uninstall.sh` from the agent directory of the installer archive,
  or `sudo /opt/alphaci/bin/alphaci-supervisor --stop-tunnels` on its own. It disables the polling timers, then stops every tunnel. Containers,
  credentials, and data remain.
- Windows uninstall (`Uninstall-AlphaCIHost.ps1`) does the same through WSL.

For production, use a **named tunnel on the customer's own domain**: create it
with `cloudflared tunnel create` on the machine, route a hostname in the customer's
DNS zone to it, keep its credentials on the machine, and run it as its own service
pointing at the environment's frontend host port (Hosting lists it as "port N → 3000").
Then choose **Through an existing proxy or domain** and enter that HTTPS hostname.
AlphaCI does not create or rotate named tunnels yet; the hostname and its
credentials stay with the customer.

The Windows test command uses sign-in startup. The agent publishes every host
port AlphaCI reserved on the machine (returned by each heartbeat) and the host
port of every environment materialized there to
`/opt/alphaci/published-ports.json`; the Windows tasks forward exactly those
ports (plus any static `-Ports`) and open them to the allowed client subnets,
removing forwards and `AlphaCI TCP <port>` rules once a port is no longer used.
Rerun the installer only to change client subnets. A client server uses its dedicated
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

A hosted backend that is not on a developer PC needs the settings in
[Point customer machines at the deployed API](#point-customer-machines-at-the-deployed-api).

## Ubuntu package (.deb)

Ubuntu machines can install the agent as a package instead of running
`install.sh`. Each `onprem-agent-v<version>` release attaches
`alphaci-agent_<version>_all.deb` with its `.sha256` file.

1. Download the package and its checksum file, then verify it:
   `sha256sum -c alphaci-agent_<version>_all.deb.sha256`.
2. Install Docker Engine first, as in Part 2. Otherwise apt installs `docker.io`
   as a recommended package. Then run `sudo apt-get install ./alphaci-agent_<version>_all.deb`.
   The package lays the agent out under `/opt/alphaci` and installs the machine
   units. Installing it does not enroll the machine and does not start polling.
3. Enroll once: `sudo alphaci-enroll https://YOUR-API`. The code is prompted for
   as usual. To enroll from an install file instead of pasting, run
   `sudo env ALPHACI_ENROLL_CODE_FILE=/path/to/code-file alphaci-enroll https://YOUR-API`.
   The file is deleted once AlphaCi answers: an accepted enrollment, or a refusal
   because the code is invalid, used or expired. If the connection fails, or AlphaCi
   is busy or throttling, the file stays, so the same command can be run again.
   Use `--replace` with a replacement code, as step 5 describes.
4. Wait for Connected in AlphaCI, as step 6 describes.

Removing the package stops polling. Credentials, trust keys and assignment data
stay under `/opt/alphaci` until someone deletes them.

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
| Enrollment returns 503: "Publish or configure a verified installer release" | On the backend, check `ONPREM_INSTALLER_RELEASE_REPO` and `ONPREM_INSTALLER_VERSION`, and confirm the release `onprem-agent-v<version>` is public and has all three assets. The backend log names the failed check. |
| Backend log: "The release is not immutable" | No hash is pinned, and the release is not marked immutable. Turn on immutable releases for the repository, or set `ONPREM_INSTALLER_SHA256` to the release's hash. |
| Backend log: "Installer archive does not match its expected SHA-256" | The archive differs from the pinned hash, or from the hash in `installer-release.json`. Check the release assets, and confirm that the pin matches the release you intend to serve. |

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

## Point customer machines at the deployed API

Enrolled machines keep the API address in `/opt/alphaci/machine.json` (`apiUrl`)
and call it on every check-in. A backend running on a developer PC stops
answering when that PC is off, so host the API where it stays running and keep
its public address stable.

### Environment on the deployed backend

Set these in the hosting service's environment, such as Render's Environment
page, then redeploy. Do not commit values to the repository.

| Variable | Value |
|---|---|
| `PLATFORM_PUBLIC_URL` | Public HTTPS origin, for example `https://api.example.com`, with no path, query, or credentials. |
| `TRUST_PROXY_HOPS` | Optional. Reverse proxies in front of the API. Default `1` (Render's edge alone). Set `2` only while a Vercel rewrite proxies the API, and never higher than the real chain. See [Agent request limits](#agent-request-limits). |
| `ONPREM_RELEASES_ENABLED` | `true` |
| `ALPHACI_RELEASE_TRUST_KEYS_JSON` | The one-line JSON from Part 5, step 13. |
| `ONPREM_INSTALLER_RELEASE_REPO` | The repository that publishes installer releases, as `owner/repo`. |
| `ONPREM_INSTALLER_VERSION` | The installer version to serve, for example `0.2.0`. |
| `ONPREM_INSTALLER_SHA256` | Recommended. The SHA-256 of `alphaci-agent-<version>.tar.gz`, copied from that release's `installer-release.json` after you have checked the release yourself. Enrollment then trusts this value rather than the release contents. |
| `ONPREM_INSTALLER_RELEASE_TOKEN` | Optional. A GitHub token used only for API calls, to avoid the shared unauthenticated rate limit. Keep it secret. |

Leave `ONPREM_INSTALLER_URL` and `ONPREM_INSTALLER_PATH` empty. A complete
explicit URL and SHA-256 pair takes priority over the release lookup, and a URL
without its hash refuses enrollment. `ONPREM_INSTALLER_PATH` serves a local
archive from the same machine and has no use on a hosted backend. Set
`ENV_PROVISIONING_ENABLED=true` as well when hosts also back project environments
(Part 5).

The release repository must be public. Customer machines download the archive
without credentials, so a private repository breaks enrollment even when the
backend can read the release with a token. Without a pin, the backend also
requires the release to be immutable (see below). Otherwise enrollment returns
503 and issues no code.

### Agent request limits

Agent endpoints (`POST /onprem/heartbeat`, `GET /onprem/assignments`, and
`POST /onprem/deployments/:deploymentId/status`) have two limits, each counted
per minute:

- **120 requests per machine** per endpoint. The count follows the machine's
  credential, so machines behind one NAT do not share it. A supervisor on its
  30-second timer sends 2 heartbeats and 2 assignment polls a minute; each
  deployment status report adds one more, so 120 leaves room for bursts and
  retries.
- **300 requests per client address** per endpoint, across every credential.
  Only requests that need a credential lookup count, so a machine's own
  rejected traffic cannot use up its NAT neighbours' share. This bounds the work
  a flood can cause. A NAT shared by more than about 60 machines that all
  reconnect at once can reach it, so keep such machines on separate networks.

Each count is a fixed window that starts with the first request of the minute.
A machine over its limit gets `429 Too Many Requests` with `Retry-After: 60`.
It is accepted again within a minute, and it needs no action.

Requests with an unknown or revoked credential count against their client
address. Each address gets 30 lookups a minute that find no machine. After that,
such requests are not looked up again, so a flood of made-up tokens cannot load
the database. A machine verified earlier keeps its own bucket meanwhile.

`POST /onprem/enroll` takes no credential, so it stays limited per client IP:
5 requests per minute. Enroll machines one at a time when several sit behind one
NAT, or wait a minute between them.

The client IP comes from `TRUST_PROXY_HOPS` (default `1`, Render's edge alone).
Set it to `2` only while a Vercel rewrite sits in front of the API. A value that
is too low shares one IP bucket across every client; a value that is too high
lets a client spoof its address. Machine limits do not depend on the IP.

The counters live in each API instance's memory. With several instances, a
machine can make up to 120 requests per minute to each instance.

### Apply the migrations

If Part 5 has not run against this database, apply its migrations first. Then
apply the five on-prem migrations in this order. Each one is idempotent, so
running it again is a safe recovery step.

```bash
npm run db:apply -- 20260928210000_onprem_compose_provider.sql 20261015010000_one_active_onprem_host.sql 20261015020000_onprem_machines.sql 20261015030000_onprem_machine_assignments.sql 20261016010000_end_revoked_machine_bindings.sql
```

### Protect published releases

Without a pin, the backend trusts the hash in a release's `installer-release.json`,
so it refuses any release that GitHub does not mark immutable. Immutable releases
stop a published release from being changed later. Protect the repository before
the first customer enrolls. These are repository settings, so an administrator
makes them. The pipeline does not:

1. Turn on immutable releases for the repository, so a published release's
   assets cannot be replaced.
2. Add a tag ruleset for `onprem-agent-v*` that blocks updating and deleting
   tags, so a published tag cannot be moved to another commit.
3. Pin the hash. Set `ONPREM_INSTALLER_SHA256` on the deployed backend to the
   value in the release's `installer-release.json`, after you have checked the
   release. A pinned hash is checked against the archive bytes at most every
   10 minutes, the cache window, and does not depend on release metadata. If the
   release changes after you pin it, the check fails and enrollment stops.

### Cut an installer release

1. Merge a change that sets `version` in `deploy/onprem/agent/release-manifest.json`
   to the new version. The tag must match this value, or the workflow fails.
2. On the merged commit, create an annotated tag and push it. This example
   publishes `0.1.1`:

   ```bash
   git tag -a onprem-agent-v0.1.1 -m "On-prem agent 0.1.1"
   git push origin onprem-agent-v0.1.1
   ```
3. The **On-prem agent release** workflow packages the archive, checks its
   checksum, and creates the GitHub Release. Confirm that the release has
   `alphaci-agent-<version>.tar.gz`, `alphaci-agent-<version>.tar.gz.sha256`,
   and `installer-release.json`. Manual dispatch from a branch only builds the
   archive as a workflow artifact. Dispatch from the tag to publish it.
4. Check the new release, then set `ONPREM_INSTALLER_VERSION` to the new version
   and `ONPREM_INSTALLER_SHA256` to its hash, and redeploy. Codes issued
   afterwards carry the new archive. A code issued earlier still points at the
   release it was issued for, which stays unchanged while the release is
   immutable.

If a release is wrong, publish the next version. The workflow fails for a tag
whose release already exists, but only the repository settings above stop an
existing release from being edited. The archive is not signed. Its trust comes
from the pinned SHA-256, or, without a pin, from an immutable release's
`installer-release.json`.

### Move an enrolled machine

These commands run on Ubuntu. The Windows installer runs the same enrollment
inside its WSL distro. `enroll.sh` checks the saved state before it changes
anything:

- The saved API address matches: it keeps the existing enrollment and changes
  nothing. With `--replace` and a replacement code, it re-enrolls the machine.
- The address differs: it refuses with "enrolled with a different API" unless
  you pass `--replace` with a code from the new API. The steps below make the
  same move by hand.
- A saved pending enrollment response for another address is refused as well.

To replace the credential of a machine that is already enrolled, to switch it to
the install's signing key, or to add a trust entry by hand, follow
[Switching an existing host to the install's signing key](runbook-selfhost-install.md#switching-an-existing-host-to-the-installs-signing-key).

**Same address and same database.** Nothing changes on the machine. The
credential is stored by hash in the database, so the machine keeps connecting.
Confirm that it shows Connected under Hosts after its next check-in.

**New address, or a new database.** Re-enroll:

1. In the deployed AlphaCI workspace, create a new enrollment for the machine.
   If the deployed backend uses the same database as the old one, pass the old
   machine's ID as `replacesMachineId` in `POST /workspaces/:workspaceId/onprem-host-enrollments`.
   Consuming the code then revokes the old record. A different database has no
   old record, so omit the field.
2. On the machine, stop the timer and move the saved enrollment aside. The
   files are root-only, so the loop runs under `sudo`. A saved pending response
   for the old address would make `enroll.sh` refuse, so it is moved too. The
   assignment directories and application data are not touched:

   ```bash
   sudo systemctl disable --now alphaci-machine.timer
   sudo sh -c 'install -d -m 0700 /opt/alphaci/enrollment-backup
   for file in machine.json trust.json secrets/machine-token secrets/enrollment-response.json; do
     if [ -e "/opt/alphaci/$file" ]; then mv "/opt/alphaci/$file" /opt/alphaci/enrollment-backup/; fi
   done'
   ```
3. Enroll with the new code. Paste it at the hidden prompt:

   ```bash
   sudo bash ~/onprem/agent/install.sh --enroll https://YOUR-BACKEND ubuntu
   ```
4. Wait for Connected under Hosts. Reassign any environment that does not show
   the new machine. Then delete the backup, which holds the old machine token
   and trust file:

   ```bash
   sudo rm -rf /opt/alphaci/enrollment-backup
   ```
