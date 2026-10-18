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

## Known limitation: existing on-prem hosts must re-enroll

Phase 1 signs releases with the customer-held key that `init` generated. An on-prem host that was set up before this key existed trusts a different key, so it rejects the new releases. Each such host must be re-enrolled so that it trusts the new key ID that `init` printed. The enrollment steps are in the on-prem host runbook (`docs/runbooks/runbook-onprem-host-setup.md`). The re-enroll-for-a-new-trust-key procedure is not written up yet, so confirm it with Alpha Explora before the rollout. Until a host is re-enrolled, it keeps running the release it already has.

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
