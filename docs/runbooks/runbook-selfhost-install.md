---
type: "Playbook"
title: "Self-hosted AlphaCI install (phase 1)"
description: "Install the AlphaCI appliance on one customer server with Docker Compose, behind Caddy on one HTTPS origin."
tags: [runbook, selfhost, install, compose]
status: draft
sources:
  - id: compose
    resource: "deploy/selfhost/compose.yaml"
    title: "Appliance compose file"
  - id: ctl
    resource: "src/cli/alphaci-ctl.ts"
    title: "Setup CLI"
  - id: env
    resource: "deploy/selfhost/alphaci.env.example"
    title: "Settings reference"
  - id: host-enroll
    resource: "deploy/onprem/agent/enroll.sh"
    title: "Host enrollment and trust file"
  - id: host-render
    resource: "deploy/onprem/agent/render-assignment.sh"
    title: "Per-assignment release key check"
---
# Self-hosted AlphaCI install (phase 1)

Phase 1 runs AlphaCI on one customer server with Docker Compose. Caddy serves one HTTPS origin: `/api/*` goes to the backend and everything else goes to the frontend. GitHub-hosted runners still reach the `/ci/*` routes (under `/api/v1/ci/`) over the internet. The customer keeps github.com, GHCR and SonarCloud. Alpha Explora builds the images, and the customer never builds from source.

Phase 1 is not egress-only. The inbound rule below is still required.

## Prerequisites

- A Linux server with Docker Engine 24 or later and the Compose plugin (`docker compose version` shows v2).
- At least 2 vCPU, 4 GB RAM, 40 GB disk.
- A DNS name for the appliance, for example `alphaci.acme.example`, pointing at the server.
- Inbound TCP 443 from the internet (see the firewall section). Inbound TCP 80 too, when you use automatic certificates.
- Outbound HTTPS to the hosts in the egress table below.
- A GitHub organization that the customer owns, and an account with owner rights on it.
- The release bundle (this `deploy/selfhost/` directory) and the image digests for the release. Alpha Explora provides both.
- Pull access to `ghcr.io` for the two images. Authenticate with a machine token: `docker login ghcr.io -u <user> --password-stdin`.

Create the install directory owned by uid 1001. The backend container runs as that uid, and `init` writes the secrets there:

```bash
sudo install -d -o 1001 -g 1001 -m 0750 /opt/alphaci
sudo cp -r deploy/selfhost/. /opt/alphaci/
cd /opt/alphaci
cp .env.example .env   # then set the two image digests from the release
```

## Firewall

| Direction | Port | To | Why |
|---|---|---|---|
| Inbound | 443 | the appliance | The web app, the API, the `/api/v1/ci/*` routes that runners call, and the OAuth callback. |
| Inbound | 80 | the appliance | Only with automatic certificates (`ALPHACI_TLS_DIRECTIVE` empty). It serves the ACME challenge and redirects to HTTPS. |
| Inbound | any other | — | Deny. Postgres is not published. |

Restrict `/ci/*` to the GitHub Actions source ranges. Those ranges are published at `https://api.github.com/meta` under `actions`. Apply the filter in the firewall, or in front of the appliance. Do not block the web app, the OAuth callback, or the non-CI API paths with the same rule. Refresh the list on a schedule, because GitHub changes it.

Outbound HTTPS, all on 443:

| Host | Used for |
|---|---|
| `github.com`, `api.github.com` | Repository, workflow and App API calls, and the OAuth exchange. |
| `ghcr.io` | Pulling the images on upgrade. |
| `avatars.githubusercontent.com` | GitHub user avatars shown in the app. |
| `lh3.googleusercontent.com` | Google-hosted avatars for accounts that use Google images. |
| `sonarcloud.io` | SonarCloud quality results, when SonarCloud is used. |
| The host for certificate issuance (`acme-v02.api.letsencrypt.org`), automatic mode only | Certificate issuance and renewal. |

Nothing must reach the appliance from the customer network other than the browsers and the GitHub runners. The database is on an internal Docker network and has no route out.

## Create the customer-owned GitHub App and OAuth App

Create both under the customer's organization, not under Alpha Explora. The App is the identity that calls the GitHub API, and the OAuth App signs users in.

**GitHub App** (Settings, then Developer settings, then GitHub Apps, then New GitHub App):

1. Name it, for example `AlphaCI acme`. Set the homepage URL to `https://alphaci.acme.example`.
2. Callback URL: `https://alphaci.acme.example/api/v1/auth/github/callback`.
3. Webhook: set the URL to `https://alphaci.acme.example/api/v1/github/webhooks`, and choose a webhook secret. Keep it for step 4 below.
4. Permissions: grant the set Alpha Explora lists for the App. Confirm that list before you create the App, because the permissions are part of the customer's GitHub configuration. Install the App on the customer organization.
5. Generate a private key. The browser downloads a `.pem` file.
6. Note the App ID and the slug (the name in the App's public URL).

**OAuth App** (Settings, then Developer settings, then OAuth Apps): homepage `https://alphaci.acme.example`, callback `https://alphaci.acme.example/api/v1/auth/github/callback`. Note the client ID and generate a client secret.

## Install

Run each step from the install directory.

1. **Set the public address and write the settings and secrets.**

   ```bash
   ./alphaci-ctl init alphaci.acme.example --tls auto
   ```

   `--tls` takes `auto` (Caddy's automatic public certificates), `internal` (Caddy's private CA, for a lab), or `custom` (place `fullchain.pem` and `privkey.pem` in `certs/`). `init` writes `alphaci.env` and five generated secrets under `secrets/`: session secret, database password, database URL, the P-256 release signing key, and the environment-token encryption key (`env_provisioning_encryption_key`, 32 random bytes). It never overwrites a file that exists. It prints the release signing key ID. Keep a copy of that ID, because customer hosts trust it.

2. **Place the three GitHub secrets** in `secrets/`, with these exact names and no extension:

   | File | Contents |
   |---|---|
   | `secrets/github_app_private_key` | The App's `.pem` file. |
   | `secrets/github_oauth_client_secret` | The OAuth App client secret. |
   | `secrets/github_app_webhook_secret` | The webhook secret from step 3 above. |

   Back up `secrets/env_provisioning_encryption_key` with the database. The backend uses it to decrypt stored environment tokens, so a restored database cannot read them without this key.

   Make them readable only by uid 1001: `sudo chown 1001:1001 secrets/* && sudo chmod 600 secrets/*`.

3. **Fill in the GitHub values** in `alphaci.env`: `GITHUB_CLIENT_ID`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_ENFORCED_ORG`.

4. **Start the stack.**

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

   Startup order: `db` becomes healthy, then `migrate` applies the migration tree and exits with status 0, then `api` starts and becomes healthy, then `web`, then `proxy`. If `migrate` fails, `api` does not start. Read the cause with `docker compose logs migrate`.

5. **Grant the first super-admin.** The user must sign in once first, which creates their account:

   1. Open `https://alphaci.acme.example` and sign in with GitHub.
   2. Run:

      ```bash
      ./alphaci-ctl admin-grant --github-login <your-login>
      ```

   If the user has not signed in yet, the command stops and tells you to ask them to sign in first. A pending grant applied at the first sign-in is not implemented in phase 1.

6. **Check the installation.**

   ```bash
   ./alphaci-ctl doctor
   ```

   `doctor` checks the database connection, that migrations are at head, that the signing key is readable and is a P-256 key (it prints its key ID), that the required settings are present and match the self-hosted profile, that every public URL is derived from `ALPHACI_HOSTNAME`, that `PLATFORM_PUBLIC_URL` is HTTPS and reachable from GitHub runners, and that the appliance reaches `api.github.com` and `ghcr.io`. Exit status 0 means every check passed.

## Backup

Back up two things together, taken at the same time:

- The database: `docker compose exec -T db pg_dump -U alphaci -d alphaci -Fc > alphaci-$(date +%F).dump`.
- The `secrets/` directory and `alphaci.env`. Without the release signing key, a restored install cannot sign releases that existing hosts trust, and without the session secret every user is signed out.

Store the backup encrypted and off the server. Restore a dump with `pg_restore --clean --if-exists -U alphaci -d alphaci <file>` into an empty database, then run `docker compose up -d migrate` to confirm the schema is at head.

## Upgrade

1. Take a backup (above).
2. Edit `.env` and set the new `ALPHACI_API_IMAGE` and `ALPHACI_WEB_IMAGE` digests from the release notes.
3. Run:

   ```bash
   docker compose pull
   docker compose up -d
   ```

`migrate` runs before `api` on every `up`, so pending migrations apply first. A migration that fails stops the upgrade, and `api` keeps running the previous image. Check with `./alphaci-ctl doctor` afterwards.

To go back to the previous release, set the previous digests and run `up -d` again. Schema changes are not reversed. If a migration must be undone, restore the backup taken before the upgrade.

## Switching an existing host to the install's signing key

An on-prem host runs only releases whose signing key ID is in its trust file. This section shows how to make an existing host trust the key that this install signs with. For enrollment in general, see the [on-prem host setup runbook](runbook-onprem-host-setup.md).

This procedure has not been run on a live host. The steps follow the code paths named below. Test one host before you switch a fleet.

### When you need this

Do this when:

- You switch the install to file signing (`ALPHACI_RELEASE_SIGNER=file`), and the host was enrolled before the switch.
- You rotate the signing key.
- You move a host from another AlphaCI API, such as the SaaS service, to this install.

A host enrolled after the switch needs nothing. Enrollment gives it the install's trust keys.

### Before you start

1. Find the key ID. Run `./alphaci-ctl doctor` in the install directory. The check `release signing key is readable and P-256` prints `key ID sha256:<hex>`. The host must trust exactly that ID.
2. Turn on on-prem hosts in `alphaci.env`. Edit the file in the install directory and set the on-prem block from `deploy/selfhost/alphaci.env.example`: `ONPREM_RELEASES_ENABLED=true`, `ENV_PROVISIONING_ENABLED=true`, and one installer source (`ONPREM_INSTALLER_RELEASE_REPO`, or `ONPREM_INSTALLER_URL` with `ONPREM_INSTALLER_SHA256`). Then run `./alphaci-ctl doctor`. The check `on-prem settings are present and valid` names each setting that is missing or malformed. The check `release trust key for on-prem hosts is available` prints the key ID that enrollment trusts. Both checks run only while `ONPREM_RELEASES_ENABLED=true`.

   Merge the server-side file signing change (PR #208) before you use this procedure. Without it, the install does not trust its own signing key, and enrollment returns 503 (`Configure P-256 public release trust keys before enrollment.`) until `ALPHACI_RELEASE_TRUST_KEYS_JSON` lists the key ID.

### What an unknown key ID does

Each host reads the `envelope.signature.keyId` of every release it receives, and looks it up in `/opt/alphaci/trust.json` (`deploy/onprem/agent/render-assignment.sh`). If the key ID is missing:

- The host pulls no image and changes no Compose project. The running release keeps running.
- The host reports the deployment as `failed` with this detail: `Release key is not pinned on this host. Nothing was deployed.`
- A `failed` deployment is final. Re-enrolling does not retry it. Start a new deployment, as [Verify the switch](#verify-the-switch) describes.
- The Hosts screen still shows the machine as Connected. Check-ins report Docker only, so the trust gap does not appear on the machine card.
- The environment operations panel shows the deployment as Failed, with the detail text.

### Option A: replace the host's credential

Use this option first. Enrollment writes the whole `trust.json` from the install's trust keys (`deploy/onprem/agent/enroll.sh`), so the new key is added in the same step.

1. In **Hosts**, open the host's card and choose **Replace credential**. Then choose **Confirm new credential**. AlphaCI shows a new enrollment code. The old credential keeps working until the new code is used.
2. On the host, run the install file or the command for its platform. Each one already includes the replacement flag, so do not add it yourself.

   | Install method | What to run |
   |---|---|
   | Ubuntu, install file | Run the downloaded `alphaci-install-<machine>.sh`, as the Hosts screen describes. |
   | Ubuntu, command | Run the command from Hosts. It ends with `install.sh --enroll <API URL> --replace`. Paste the code at the hidden prompt. |
   | Ubuntu, `.deb` | Run `sudo alphaci-enroll https://YOUR-API --replace`. Paste the code, or set `ALPHACI_ENROLL_CODE_FILE` as the on-prem host setup runbook describes. |
   | Windows with WSL | Run the downloaded `alphaci-install-<machine>.cmd`, or the PowerShell command from Hosts, as the Windows account that owns the WSL distro. Both end with `-ReplaceCredential`. |

3. Wait for **Connected** on the Hosts screen. A check-in runs at most 30 seconds after the host writes its new credential.

Running workloads during the switch:

- Enrollment does not stop or restart containers. It writes only the credential, `machine.json`, and `trust.json`, all under `/opt/alphaci` (`deploy/onprem/agent/enroll.sh`).
- The host's environments move to the new machine record, and each keeps its host ports where they are free (`moveMachineBindings` in `onprem-assignments.repository.ts`). Assignments stay as they are.
- In each cycle, the host acts only on deployments that are pending or deploying. An application with no such deployment is not touched. A pending or deploying deployment is picked up again on the next cycle.
- A check-in that runs after the old credential stops working, and before the host writes the new one, returns 401. The supervisor then stops every automatic HTTPS tunnel on the host (`deploy/onprem/agent/alphaci-supervisor.sh`). The next check-in starts them again. The tunnel status says the address changes when the tunnel restarts (`deploy/onprem/agent/tunnel.sh`).
- For a tunnel-mode host, AlphaCI does not hand out a production deployment until the tunnel reports a running address (`hostAssignments` in `release-registry.service.ts`).

### Revoke and add a new host instead

Use this only when you cannot replace the credential. It differs from Option A because the environments lose their host.

- **Revoke access** ends the machine's environment bindings and releases their host ports (`endMachineBindings` and the `onprem_ports_release` trigger). Running applications stay on the host. AlphaCI does not manage them until you assign each environment again in Hosting.
- The machine still holds its old credential on disk. A fresh enrollment on that machine needs the replacement flag, so add `--replace` (or `-ReplaceCredential` on Windows) yourself. The Hosts command adds the flag only for a replacement from a host card. Without it, `enroll.sh` prints `Existing machine enrollment retained`, exits 0, and the installer starts the timer with the revoked credential.

### Option B: add the trust entry by hand

Use this option only when Option A is not possible. The host reads `trust.json` on every timer run, so an edit takes effect on the next run. No restart is needed (`render-assignment.sh`). The file is a JSON object that maps each key ID to its PEM public key. Enrollment writes it with owner root and mode 0600.

Read these limits before you edit:

- The host does not check that the PEM matches its key ID. A wrong PEM fails signature verification, so the release is refused. It is not accepted.
- Take the PEM from this install's key only.
- Re-enrolling replaces the whole file. A key you added by hand survives only when the install still lists it in `ALPHACI_RELEASE_TRUST_KEYS_JSON`.
- AlphaCI does not record the change, and Hosting does not show it.

1. On the appliance, write the public key and print its key ID. The key file belongs to the backend user, so use `sudo`:

   ```bash
   cd /opt/alphaci
   sudo openssl pkey -in secrets/release_signing_key -pubout -out release-signing.pub.pem
   echo "sha256:$(sudo openssl pkey -in secrets/release_signing_key -pubout -outform DER | sha256sum | cut -d' ' -f1)"
   ```

2. Copy `release-signing.pub.pem` to the host. Compare the key ID from step 1 with the key ID from `alphaci-ctl doctor`. Stop if they differ.
3. On the host, add the entry under the key ID. The command writes to a temporary file first, then installs it with mode 0600:

   ```bash
   KEY_ID='sha256:<hex from alphaci-ctl doctor>'
   sudo jq --arg id "$KEY_ID" --rawfile pem ./release-signing.pub.pem '. + {($id): $pem}' /opt/alphaci/trust.json > /tmp/trust.json.new
   sudo install -m 0600 /tmp/trust.json.new /opt/alphaci/trust.json
   rm -f /tmp/trust.json.new ./release-signing.pub.pem
   ```

4. Confirm the entry: `sudo jq -r 'keys[]' /opt/alphaci/trust.json` lists the key ID.

The single-environment agent (`alphaci-agent.timer` with `agent.env`) does not read `trust.json`. It verifies each release with the PEM at `ALPHACI_TRUST_KEY`, read on every run, and it does not compare key IDs (`deploy/onprem/agent/alphaci-agent.sh`). On that host, replace the PEM file at `ALPHACI_TRUST_KEY` with the install's public key. No restart is needed. The on-prem host setup runbook pins this file at `/opt/alphaci/trust/release-signing.pub.pem`.

### Verify the switch

1. On the host, `sudo jq -r 'keys[]' /opt/alphaci/trust.json` lists the key ID from `alphaci-ctl doctor`.
2. Start a new deployment:
   - For a later environment, choose **Promote** on the release that the previous environment runs.
   - For the first environment, a release deploys when it is registered. Registration needs a new workflow run, because a workflow run registers one release (`release-registry.service.ts`).
3. Check the result:
   - The environment operations panel shows **Healthy** for the deployment.
   - On the host, `sudo tail -n 5 /opt/alphaci/assignments/<project-id>/<environment-id>/worker.log` shows `deployment <deployment-id> healthy`.

If the deployment shows **Failed**, read its detail:

| Detail | Meaning and action |
|---|---|
| `Release key is not pinned on this host. Nothing was deployed.` | `trust.json` has no entry for the key ID. Repeat Option A or Option B. The same text appears in `journalctl -u alphaci-machine.service`. |
| `The host rejected the release signature, manifest hash, or project, so nothing was pulled.` | The key ID is trusted, but the signature, manifest hash, or project check failed. Compare the entry with the key that signs the release, and check that the release belongs to this project. |

### Key rotation

Keep the old key's entry in `ALPHACI_RELEASE_TRUST_KEYS_JSON` for as long as a release that the old key signed can still be deployed. The rotation section of the on-prem host setup runbook gives the same rule for the Cloud KMS path.

## Open decisions

- The customer's GitHub plan (Enterprise Cloud or a lower tier) decides which GitHub features the App can use. Confirm it before the install.
- Offline licensing is not part of phase 1. The appliance needs outbound HTTPS to GitHub.
- `GITHUB_INTERNAL_ORG` is not set in `alphaci.env.example`. Set it to the organization name if sign-in should require membership of that organization.
- Image digests and the release signing key are per install. Keep the signing key ID that `init` printed with the customer record, because existing hosts trust it.

## Troubleshooting

| Symptom | Check |
|---|---|
| `migrate` exits non-zero | `docker compose logs migrate`. A checksum mismatch means an applied migration file changed. Do not edit the file. |
| `api` unhealthy | `docker compose logs api`. A missing setting or unreadable secret stops it at boot with the name of the setting. |
| `doctor` fails outbound HTTPS | DNS and egress from the server. The firewall rule above must allow it. |
| `doctor` says `PLATFORM_PUBLIC_URL` is not reachable | The hostname must be public, with a public certificate, and not `localhost` or a private address. |
| Browser shows a certificate warning | Automatic mode needs public DNS and port 80 and 443 open. Internal mode is not trusted by browsers. |
