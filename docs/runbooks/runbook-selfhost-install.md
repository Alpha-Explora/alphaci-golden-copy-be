---
type: "Playbook"
title: "Self-hosted AlphaCI install"
description: "Install, upgrade, back up, and check the AlphaCI appliance on one customer server with Docker Compose, behind Caddy on one HTTPS origin."
tags: [runbook, selfhost, install, compose]
status: draft
sources:
  - id: compose
    resource: "deploy/selfhost/compose.yaml"
    title: "Appliance compose file"
  - id: ctl
    resource: "deploy/selfhost/alphaci-ctl"
    title: "Setup CLI wrapper"
  - id: ctl-source
    resource: "src/cli/alphaci-ctl.ts"
    title: "Setup CLI"
  - id: env
    resource: "deploy/selfhost/alphaci.env.example"
    title: "Settings reference"
  - id: app-routes
    resource: "deploy/selfhost/alphaci-app-routes"
    title: "Routes for apps deployed on the server"
  - id: host-enroll
    resource: "deploy/onprem/agent/enroll.sh"
    title: "Host enrollment and trust file"
  - id: host-render
    resource: "deploy/onprem/agent/render-assignment.sh"
    title: "Per-assignment release key check"
---
# Self-hosted AlphaCI install

The appliance runs AlphaCI on one customer server with Docker Compose. Caddy serves one HTTPS origin: `/api/*` goes to the backend and everything else goes to the frontend. GitHub-hosted runners call the `/api/v1/ci/*` routes over the internet. The customer keeps github.com, GitHub-hosted runners, GHCR, and SonarCloud. Alpha Explora builds the images; the customer never builds from source.

The appliance needs inbound HTTPS from GitHub's runners (see [Firewall](#firewall)).

| Service | What it runs |
|---|---|
| `proxy` | Caddy 2. Publishes 80 and 443. |
| `web` | Frontend image (`ALPHACI_WEB_IMAGE`), built with `NEXT_PUBLIC_API_BASE_URL=/api/v1` for every customer. Port 3000, health `GET /healthz`. |
| `api` | Backend image (`ALPHACI_API_IMAGE`). Port 4000, health `GET /api/v1/health`. |
| `migrate` | The backend image, run once per `up`. Applies pending migrations and exits. `api` starts only after it exits with status 0. |
| `db` | PostgreSQL 16 on the named volume `pgdata`. Not published, and on an internal network with no route out. |

## Prerequisites

- A Linux server with Docker Engine 24 or later and the Compose plugin (`docker compose version` shows v2).
- At least 2 vCPU, 4 GB RAM, 40 GB disk.
- A DNS name for the appliance, for example `alphaci.acme.example`, pointing at the server.
- Inbound TCP 443 from the internet, and inbound TCP 80 when you use automatic certificates.
- Outbound HTTPS to the hosts in the egress table below.
- A GitHub organization the customer owns, and an account with owner rights on it.
- The release bundle (the `deploy/selfhost/` directory) and the two image digests. Alpha Explora provides both.
- Pull access to `ghcr.io` for the two images: `docker login ghcr.io -u <user> --password-stdin` with a machine token.

Create the install directory owned by uid 1001. The backend container runs as that uid, and `init` writes the secrets as it:

```bash
sudo install -d -o 1001 -g 1001 -m 0750 /opt/alphaci
sudo cp -r deploy/selfhost/. /opt/alphaci/
cd /opt/alphaci
cp .env.example .env   # then set ALPHACI_API_IMAGE and ALPHACI_WEB_IMAGE to the release digests
```

`.env` holds only the image pins and optional overrides: `ALPHACI_DB_IMAGE` (default `postgres:16-alpine`), `ALPHACI_PROXY_IMAGE` (default `caddy:2-alpine`), `ALPHACI_HTTP_PORT` (default 80), and `ALPHACI_HTTPS_PORT` (default 443).

## Firewall

| Direction | Port | To | Why |
|---|---|---|---|
| Inbound | 443 | the appliance | The web app, the API, the `/api/v1/ci/*` routes that runners call, the OAuth callback, the GitHub webhook, and app addresses under `ONPREM_APPS_DOMAIN`. |
| Inbound | 80 | the appliance | Automatic certificates only (`ALPHACI_TLS_DIRECTIVE` empty, and every app address under `ONPREM_APPS_DOMAIN`). It serves the ACME challenge and redirects to HTTPS. |
| Inbound | any other | — | Deny. Postgres is not published. |

You can restrict `/api/v1/ci/*` to the GitHub Actions ranges published at `https://api.github.com/meta` under `actions`. Apply that filter in the firewall or in front of the appliance, not to the web app, the OAuth callback, or the webhook. Refresh the list on a schedule, because GitHub changes it.

Outbound HTTPS, all on 443:

| Host | Used for |
|---|---|
| `github.com`, `api.github.com` | Repository, workflow, and App API calls, the OAuth exchange, and installer release downloads. |
| `ghcr.io` | Pulling the images on upgrade. |
| `avatars.githubusercontent.com` | GitHub user avatars. |
| `lh3.googleusercontent.com` | Google-hosted avatars. |
| `sonarcloud.io` | SonarCloud results, when SonarCloud is used. |
| `acme-v02.api.letsencrypt.org` | Certificate issuance and renewal, automatic mode only. |

## Create the customer-owned GitHub App and OAuth App

Create both under the customer's organization, not under Alpha Explora. The App calls the GitHub API; the OAuth App signs users in.

**GitHub App** (organization Settings, Developer settings, GitHub Apps, New GitHub App):

1. Name it, for example `AlphaCI acme`. Homepage URL: `https://alphaci.acme.example`.
2. Callback URL: `https://alphaci.acme.example/api/v1/auth/github/callback`.
3. Webhook URL: `https://alphaci.acme.example/api/v1/github/webhooks`. Choose a webhook secret and keep it.
4. Permissions: grant the set Alpha Explora lists for the App. Install the App on the customer organization.
5. Generate a private key. The browser downloads a `.pem` file.
6. Note the App ID and the slug (the name in the App's public URL).

**OAuth App** (organization Settings, Developer settings, OAuth Apps): homepage `https://alphaci.acme.example`, callback `https://alphaci.acme.example/api/v1/auth/github/callback`. Note the client ID and generate a client secret.

## Install

Run each step from the install directory.

1. **Write the settings and secrets.**

   ```bash
   ./alphaci-ctl init alphaci.acme.example --tls auto
   ```

   `--tls` takes `auto` (Caddy's automatic public certificates), `internal` (Caddy's private CA, for a lab; browsers and GitHub do not trust it), or `custom` (place `fullchain.pem` and `privkey.pem` in `certs/`). `init` writes `alphaci.env` and, under `secrets/`, the session secret, the database password, the database URL, the P-256 release signing key, the environment-token encryption key (`env_provisioning_encryption_key`), and empty `onprem_registry_token` and `sonar_token` files. It never overwrites an existing file. It prints the release signing key ID; keep it, because on-prem hosts trust it.

2. **Place the three GitHub secrets** in `secrets/`, with these exact names and no extension:

   | File | Contents |
   |---|---|
   | `secrets/github_app_private_key` | The App's `.pem` file. |
   | `secrets/github_oauth_client_secret` | The OAuth App client secret. |
   | `secrets/github_app_webhook_secret` | The webhook secret. |

   Make them readable only by uid 1001: `sudo chown 1001:1001 secrets/* && sudo chmod 600 secrets/*`.

3. **Fill in the GitHub values** in `alphaci.env`: `GITHUB_CLIENT_ID`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and `GITHUB_ENFORCED_ORG` (the customer's organization). Only members of that organization can sign in. Set `GITHUB_INTERNAL_ORG` only to allow a different organization.

4. **Start the stack.**

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

   Order: `db` becomes healthy, `migrate` applies the migrations and exits 0, `api` becomes healthy, then `web`, then `proxy`. If `migrate` fails, `api` does not start; read `docker compose logs migrate`.

5. **Grant the first super-admin.** The user signs in once first, which creates their account:

   1. Open `https://alphaci.acme.example` and sign in with GitHub.
   2. Run `./alphaci-ctl admin-grant --github-login <login>`.

   If the user has not signed in yet, the command stops and asks for that first. There is no pending grant applied at first sign-in.

6. **Check the installation:** `./alphaci-ctl doctor`. See [Doctor](#doctor).

## alphaci-ctl

`./alphaci-ctl` runs the CLI inside the backend image. `init` runs the image directly; the other commands run in the `api` service's environment (`docker compose run --rm --no-deps api`), so they see the same settings, secrets, and network.

| Command | What it does |
|---|---|
| `init <hostname> [--tls auto\|internal\|custom]` | Writes `alphaci.env` and the generated secrets. Existing files are kept. |
| `admin-grant --github-login <login>` | Makes an existing user a platform super-admin. |
| `doctor` | Runs the installation checks. |
| `registry-token --github-login <owner>` | Saves the read-only token hosts pull release images with. See [Private release images](#private-release-images). |
| `sonar --organization <org>` | Saves the SonarCloud token new repositories are analysed with. See [SonarCloud](#sonarcloud). |
| `sudo ./alphaci-ctl server-host --team <name or ID> --github-login <login> [--name <host name>]` | Enrolls this server's own on-prem agent. See [Run deployments on the AlphaCI server](#run-deployments-on-the-alphaci-server). |
| `help` | Prints usage. |

Exit codes: 0 success, 1 a check or database step failed, 2 usage or configuration error.

## Doctor

`./alphaci-ctl doctor` runs every check, prints `[PASS]` or `[FAIL]` for each, and exits 0 only when all pass:

- Required settings are present and match the self-hosted profile (`NODE_ENV=production`, `ALPHACI_EDITION=enterprise`, `ALPHACI_BUILD_PROFILE=enterprise`, `ALPHACI_DEPLOYMENT_MODE=selfhosted`, `SUBSCRIPTION_GATE_ENABLED=false`, `TRUST_PROXY_HOPS=1`, `SESSION_SECURE=true`, `STORAGE_DRIVER=postgres`, `ALPHACI_RELEASE_SIGNER=file`, and a session secret of at least 32 characters).
- Public URLs derive from `ALPHACI_HOSTNAME`.
- `PLATFORM_PUBLIC_URL` is HTTPS and reachable from GitHub runners (not `localhost` or a private address).
- The database is reachable, and migrations are at head.
- The release signing key is readable and P-256. It prints `key ID sha256:<hex>`.
- With `ONPREM_RELEASES_ENABLED=true` only: the on-prem settings, and the release trust key for on-prem hosts.
- Outbound HTTPS to `api.github.com` and `ghcr.io`.

## Optional settings

Edit `alphaci.env`, then run `docker compose up -d` so `api` restarts with the change, and run `./alphaci-ctl doctor`.

- **Notifications.** `NOTIFICATIONS_ENABLED=true` turns on in-app notifications. See [Workspace member notifications](../operations/workspace-member-notifications.md).
- **Hierarchy sync to GitHub teams.** `HIERARCHY_GITHUB_SYNC_MODE=live` writes grants and revocations to GitHub teams. Grant the App the organization permissions first. With `stub`, nothing is written to GitHub.
- **On-prem hosts.** The commented on-prem block in `alphaci.env.example`. See the [on-prem host setup runbook](runbook-onprem-host-setup.md#self-hosted-appliance).
- **External PostgreSQL.** Point `secrets/database_url` at the server with `sslmode=require` or `verify-full`, and set `DATABASE_CA_CERT` to its CA certificate.

## Private release images

On-prem hosts pull each project's release images from GHCR. If the images are private, give AlphaCI a read-only token to lend to hosts:

```bash
./alphaci-ctl registry-token --github-login <owner of the token>
```

Paste a token with `read:packages` for the organization at the prompt (or pipe it on stdin). The command writes `secrets/onprem_registry_token` as uid 1001, sets `ONPREM_REGISTRY_USERNAME` in `alphaci.env`, and restarts `api`. Hosts use it from their next deployment, with agent 0.4.3 or newer. Without a token, hosts pull with their own Docker login.

## SonarCloud

The Quality stage runs a SonarCloud scan when the repository has the `SONAR_TOKEN`, `SONAR_ORGANIZATION` and `SONAR_PROJECT_KEY` Actions secrets, and blocks on the quality gate for `uat` and `main`. AlphaCI creates the SonarCloud project and installs those secrets for every repository it creates, once it has a token:

```bash
./alphaci-ctl sonar --organization <SonarCloud organization key>
```

Paste a SonarCloud token that can create projects in that organization. The command writes `secrets/sonar_token` as uid 1001, sets `ALPHACI_SONAR_ORGANIZATION` and `ALPHACI_SONAR_TOKEN_FILE` in `alphaci.env`, and restarts `api`. Without it, the scan is skipped. SonarCloud's own Automatic Analysis may still comment on pull requests, but AlphaCI does not count it.

## Run deployments on the AlphaCI server

The AlphaCI server can also run the project deployments. `server-host` enrolls the server's own on-prem agent and installs `alphaci-app-routes.timer`, which gives each deployed environment a permanent HTTPS address through the install's Caddy.

Before you start:

1. Turn on on-prem hosts in `alphaci.env` (`ONPREM_RELEASES_ENABLED=true`, `ENV_PROVISIONING_ENABLED=true`) and set `ONPREM_INSTALLER_VERSION` explicitly. `server-host` refuses to run without it.
2. Make the install serve the agent archive. `server-host` downloads `https://<ALPHACI_HOSTNAME>/api/v1/onprem/installer/<version>`, which answers only when `ONPREM_INSTALLER_PATH` names the archive inside the `api` container, `ONPREM_INSTALLER_VERSION` matches, and `ONPREM_INSTALLER_SHA256` matches its bytes. `compose.yaml` mounts no archive, so add the mount, for example in `compose.override.yaml` next to it:

   ```yaml
   services:
     api:
       volumes:
         - ./installer/alphaci-agent-0.4.3.tar.gz:/opt/alphaci-installer/alphaci-agent.tar.gz:ro
   ```

   with, in `alphaci.env`:

   ```text
   ONPREM_INSTALLER_VERSION=0.4.3
   ONPREM_INSTALLER_PATH=/opt/alphaci-installer/alphaci-agent.tar.gz
   ONPREM_INSTALLER_SHA256=<sha256 of the archive>
   ONPREM_INSTALLER_URL=https://alphaci.acme.example/api/v1/onprem/installer/0.4.3
   ```

   The archive file must be readable by uid 1001. `ONPREM_INSTALLER_URL` lets **Add host** issue codes for other machines from the same archive.
3. For permanent app addresses, create a wildcard DNS record `*.<apps domain>` pointing at the server, and set `ONPREM_APPS_DOMAIN=<apps domain>` in `alphaci.env`. Caddy obtains a public certificate for each name, so inbound 80 and 443 must be open.
4. Prepare the server as an Ubuntu host (Docker and the agent's tools), as the [on-prem host setup runbook](runbook-onprem-host-setup.md#ubuntu) describes.
5. Run `docker compose up -d` and `./alphaci-ctl doctor`.

Then, as root, with a team name or ID and the GitHub login of a user who has signed in:

```bash
sudo ./alphaci-ctl server-host --team "Platform" --github-login <login>
```

It creates a one-time enrollment code for that team, downloads and verifies the archive, runs `install.sh --enroll https://<ALPHACI_HOSTNAME> ubuntu`, installs `/opt/alphaci/bin/alphaci-app-routes`, and enables `alphaci-app-routes.timer`. The machine appears in Hosts as `alphaci-server` unless `--name` is given. One server can be enrolled in several teams; host ports stay unique across them.

With `ONPREM_APPS_DOMAIN` set, every environment with a frontend gets `https://<environment>-<repository>.<domain>`, and production gets `https://<repository>.<domain>`. Production is then assigned automatically when the team has one connected machine. Every 30 seconds, `alphaci-app-routes` reads the agent's assignments, writes one Caddy site per address to `caddy/apps/apps.caddy` (proxied to the environment's host port through `host.docker.internal`), and reloads Caddy when the routes change. Without `ONPREM_APPS_DOMAIN`, environments get a Cloudflare quick tunnel instead.

## Backup

Back up these together:

- The database: `docker compose exec -T db pg_dump -U alphaci -d alphaci -Fc > alphaci-$(date +%F).dump`.
- `secrets/`, `alphaci.env`, `.env`, and any `compose.override.yaml` and `certs/`. Without the release signing key, a restored install cannot sign releases that existing hosts trust. Without `env_provisioning_encryption_key`, stored environment tokens cannot be decrypted. Without the session secret, every user is signed out.

Store the backup encrypted and off the server.

## Restore

1. On the server, restore the install directory files above (owned by uid 1001, secrets mode 0600).
2. Start only the database and restore the dump into it:

   ```bash
   docker compose up -d db
   docker compose exec -T db pg_restore --clean --if-exists -U alphaci -d alphaci < alphaci-<date>.dump
   ```

3. Run `docker compose up -d`. `migrate` brings the schema to head if the dump is older than the images.
4. Run `./alphaci-ctl doctor`.

## Upgrade

1. Take a backup.
2. Copy the new release bundle's files over the install directory: `compose.yaml`, `alphaci-ctl`, `caddy/Caddyfile`, `postgres-init/`, and the `alphaci-app-routes` files. Keep `.env`, `alphaci.env`, `secrets/`, `certs/`, `caddy/apps/`, and any `compose.override.yaml`. On a server that runs `server-host`, also copy the new script into place: `sudo install -m 0755 alphaci-app-routes /opt/alphaci/bin/alphaci-app-routes`.
3. In `.env`, set the new `ALPHACI_API_IMAGE` and `ALPHACI_WEB_IMAGE` digests from the release notes. Compare `alphaci.env` with the release's `alphaci.env.example` and add any new settings, such as `ONPREM_REGISTRY_TOKEN_FILE=/run/secrets/onprem_registry_token`. Create any secret file the new `compose.yaml` mounts that you do not have yet, such as an empty `secrets/sonar_token` owned by uid 1001, or compose will not start.
4. Run `./alphaci-ctl init <hostname> --tls <mode>` again. It keeps every existing file and creates any secret file the new `compose.yaml` mounts, such as the empty `secrets/onprem_registry_token`. Compose refuses to start while a mounted secret file is missing.
5. Run:

   ```bash
   docker compose pull
   docker compose up -d
   ./alphaci-ctl doctor
   ```

`migrate` runs before `api` on every `up`, so pending migrations apply first. A failed migration stops the upgrade, and `api` keeps running the previous image. The [database migrations runbook](runbook-database-migrations.md) describes the runner.

To go back, set the previous digests and run `docker compose up -d`. Schema changes are not reversed. If a migration must be undone, restore the backup taken before the upgrade.

## Switching an existing host to the install's signing key

An on-prem host runs only releases whose signing key ID is in its trust file. This section makes an existing host trust the key this install signs with. For enrollment in general, see the [on-prem host setup runbook](runbook-onprem-host-setup.md). Test one host before you switch a fleet.

### When you need this

- The host was enrolled before the install switched to file signing (`ALPHACI_RELEASE_SIGNER=file`).
- You rotate the signing key.
- You move a host from another AlphaCI server, such as the SaaS service, to this install.

A host enrolled with this install needs nothing. Enrollment gives it the install's trust keys.

### Before you start

1. Find the key ID: `./alphaci-ctl doctor` prints `key ID sha256:<hex>` under `release signing key is readable and P-256`.
2. Turn on on-prem hosts in `alphaci.env` (see [Optional settings](#optional-settings)) and run `./alphaci-ctl doctor`. The check `release trust key for on-prem hosts is available` prints the key ID that enrollment trusts.

### What an unknown key ID does

Each host reads `envelope.signature.keyId` of every release and looks it up in `/opt/alphaci/trust.json`. If the key ID is missing:

- The host pulls no image and changes no Compose project. The running release keeps running.
- The host reports the deployment `failed` with `Release key is not pinned on this host. Nothing was deployed.` A failed deployment is final; start a new one after the fix.
- Hosts still shows the machine as Connected. The environment operations panel shows the deployment as Failed with the detail.

### Option A: replace the host's credential

Use this option first. Enrollment rewrites the whole `trust.json` from the install's trust keys.

1. In **Hosts**, open the host's card, choose **Replace credential**, then **Confirm new credential**. The old credential keeps working until the new code is used.
2. On the host, run the install file or command for its platform. Each already includes the replacement flag.

   | Install method | What to run |
   |---|---|
   | Ubuntu, install file | The downloaded `alphaci-install-<machine>.sh`. |
   | Ubuntu, command | The command from Hosts, ending with `install.sh --enroll <API URL> --replace`. Paste the code at the hidden prompt. |
   | Ubuntu, `.deb` | `sudo alphaci-enroll https://YOUR-API --replace`. |
   | Windows with WSL | The downloaded `alphaci-install-<machine>.cmd`, or the PowerShell command from Hosts, as the account that owns the distro. Both end with `-ReplaceCredential`. |

3. Wait for **Connected**. A check-in runs at most 30 seconds after the host writes its new credential.

During the switch:

- Enrollment does not stop or restart containers. It writes only the credential, `machine.json`, and `trust.json`.
- The host's environments move to the new machine record and keep their host ports where they are free.
- A check-in between the old credential's end and the new one's start returns 401, and the supervisor stops the host's automatic HTTPS tunnels. The next check-in starts them again with new addresses.
- For a tunnel-mode host, production releases wait until the tunnel reports a running address.

### Revoke and add a new host instead

Use this only when you cannot replace the credential. **Revoke access** ends the machine's environment bindings and releases their host ports; the applications keep running unmanaged until each environment is assigned again in Hosting. The machine still holds its old credential, so add `--replace` (or `-ReplaceCredential`) to the fresh enrollment yourself. Without it, `enroll.sh` prints `Existing machine enrollment retained` and keeps the revoked credential.

### Option B: add the trust entry by hand

Use this only when Option A is not possible. The host reads `trust.json` on every run, so the edit takes effect without a restart. The file maps each key ID to its PEM public key, owner root, mode 0600.

- The host does not check that the PEM matches its key ID. A wrong PEM fails signature verification, so the release is refused.
- Re-enrolling replaces the whole file. A hand-added key survives only if the install lists it in `ALPHACI_RELEASE_TRUST_KEYS_JSON` or signs with it.
- AlphaCI does not record the change.

1. On the appliance, write the public key and print its key ID:

   ```bash
   cd /opt/alphaci
   sudo openssl pkey -in secrets/release_signing_key -pubout -out release-signing.pub.pem
   echo "sha256:$(sudo openssl pkey -in secrets/release_signing_key -pubout -outform DER | sha256sum | cut -d' ' -f1)"
   ```

2. Copy `release-signing.pub.pem` to the host. Stop if the key ID differs from the one `doctor` prints.
3. On the host:

   ```bash
   KEY_ID='sha256:<hex from alphaci-ctl doctor>'
   sudo jq --arg id "$KEY_ID" --rawfile pem ./release-signing.pub.pem '. + {($id): $pem}' /opt/alphaci/trust.json > /tmp/trust.json.new
   sudo install -m 0600 /tmp/trust.json.new /opt/alphaci/trust.json
   rm -f /tmp/trust.json.new ./release-signing.pub.pem
   ```

4. Confirm: `sudo jq -r 'keys[]' /opt/alphaci/trust.json` lists the key ID.

A legacy single-environment host (`alphaci-agent.timer` with `agent.env`) does not read `trust.json`. It verifies with the PEM at `ALPHACI_TRUST_KEY` (normally `/opt/alphaci/trust/release-signing.pub.pem`) and does not compare key IDs. Replace that file with the install's public key.

### Verify the switch

1. On the host, `sudo jq -r 'keys[]' /opt/alphaci/trust.json` lists the key ID.
2. Start a new deployment: **Promote** the release the previous environment runs, or, for the first environment, push to register a new release from a new workflow run.
3. The environment operations panel shows **Healthy**, and `sudo tail -n 5 /opt/alphaci/assignments/<project-id>/<environment-id>/worker.log` shows `deployment <deployment-id> healthy`.

| Failed detail | Meaning and action |
|---|---|
| `Release key is not pinned on this host. Nothing was deployed.` | `trust.json` has no entry for the key ID. Repeat Option A or B. |
| `The host rejected the release signature, manifest hash, or project, so nothing was pulled.` | The key ID is trusted, but the signature, hash, or project check failed. Compare the entry with the signing key, and check that the release belongs to this project. |

### Key rotation

`init` never replaces an existing signing key. To rotate, keep the old public key in `ALPHACI_RELEASE_TRUST_KEYS_JSON` for as long as a release it signed can still be deployed, then switch each host as above.

## Troubleshooting

| Symptom | Check |
|---|---|
| `init` says `Missing .env` | Copy `.env.example` to `.env` and set the image digests first. |
| `migrate` exits non-zero | `docker compose logs migrate`. A checksum mismatch means an applied migration file changed. Do not edit applied files. |
| `api` unhealthy | `docker compose logs api`. A missing setting or unreadable secret stops it at boot and names the setting. Secret files must be readable by uid 1001. |
| `doctor` fails outbound HTTPS | DNS and egress from the server. |
| `doctor` says `PLATFORM_PUBLIC_URL` is not reachable | The hostname must be public, not `localhost` or a private address. |
| Browser certificate warning | Automatic mode needs public DNS and ports 80 and 443 open. Internal mode is not trusted by browsers. |
| Sign-in refused for a user | The user must be a member of `GITHUB_ENFORCED_ORG` (or `GITHUB_INTERNAL_ORG` when set). |
| `server-host` stops with "Set ALPHACI_HOSTNAME and the on-prem installer settings" | Set `ONPREM_INSTALLER_VERSION` in `alphaci.env`. |
| `server-host` download fails with 404 | The install does not serve the archive: check `ONPREM_INSTALLER_PATH`, the mount, `ONPREM_INSTALLER_VERSION`, and `ONPREM_INSTALLER_SHA256`. |
| App address does not answer | `systemctl status alphaci-app-routes.timer`, `journalctl -u alphaci-app-routes.service`, the wildcard DNS record, and `caddy/apps/apps.caddy`. |
