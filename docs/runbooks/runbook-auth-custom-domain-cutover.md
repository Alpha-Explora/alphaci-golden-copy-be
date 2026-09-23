---
type: "Playbook"
title: "Authentication custom-domain cutover"
description: "Cut over frontend and backend to a shared parent domain so session cookies remain first-party on privacy-focused browsers."
tags: [runbook, authentication, deployment, cookies]
status: stable
sources:
  - id: app-config
    resource: "src/kernel/config/app.config.ts"
    title: "Session configuration"
  - id: bootstrap
    resource: "src/main.ts"
    title: "Session and CORS bootstrap"
---
# Authentication custom-domain cutover

## Problem

When the frontend and backend use different registrable domains, a secure `SameSite=None` session cookie can be treated as third-party by privacy-focused browsers. A shared parent domain makes the session cookie first-party across the frontend and backend subdomains.

## Interim: Vercel rewrite bridge

Use this when no shared parent domain is available yet. The frontend's Vercel deployment proxies `/api/v1/*` to the backend, so the browser only ever talks to the frontend host and the session cookie is first-party there. It is a bridge: every API call takes an extra hop through Vercel, and it is removed at the custom-domain cutover below.

Vercel preview deployments cannot complete GitHub login through the bridge: the OAuth callback is registered on the production frontend host, so the cookie lands there, not on the preview host.

### Enable

1. Backend (Render): confirm `PLATFORM_PUBLIC_URL` is set to the backend origin, e.g. `https://<backend>.onrender.com`. When it is unset, generated customer pipelines derive the platform URL from `GITHUB_CALLBACK_URL` (`resolvePlatformBaseUrl` in `staged-workflow.builder.ts`). Moving the callback to the frontend would then bake the frontend host into customer repositories' report and release URLs, and they would break when the bridge is removed.
2. Frontend (Vercel, Production scope only): set `API_PROXY_TARGET` to the backend origin and redeploy. Nothing changes for users yet. Confirm `https://<frontend>/api/v1/health` answers.
3. Cut over, back to back, because the GitHub OAuth App has a single callback URL and sign-in fails between these steps:
   1. GitHub OAuth App: set the authorization callback URL to `https://<frontend>/api/v1/auth/github/callback`.
   2. Backend (Render): set `GITHUB_CALLBACK_URL` to the same value, `TRUST_PROXY_HOPS=2`, and `SESSION_COOKIE_SAMESITE=lax`, then redeploy.
   3. Frontend (Vercel, Production): set `NEXT_PUBLIC_API_BASE_URL=/api/v1` and redeploy. `NEXT_PUBLIC_*` values are inlined at build time, so this needs a fresh build, not a restart.
4. Every user signs in once more; the old backend-host cookie is no longer used.

GitHub App webhooks keep pointing at the backend host, and the GitHub App setup URL keeps pointing at the frontend; neither changes.

### Verify

1. Sign in on Safari (or with third-party cookies blocked in Chrome). The redirect must land on the authenticated home page.
2. In devtools, API requests go to the frontend host, and the session cookie belongs to the frontend host with `SameSite=Lax`.
3. Backend logs show real client IPs rather than Vercel's. If they show Vercel's, the forwarded chain is not two hops: set `TRUST_PROXY_HOPS` back to `1` and investigate, because a wrong value either shares one rate-limit bucket across all users or lets clients spoof their IP.
4. Open a deployment target's live logs and confirm the stream connects and reconnects through the proxy.

### Roll back

Restore the previous `GITHUB_CALLBACK_URL` and GitHub OAuth App callback, unset `TRUST_PROXY_HOPS` and `SESSION_COOKIE_SAMESITE` on the backend, set frontend `NEXT_PUBLIC_API_BASE_URL` back to the backend origin, and redeploy both. `API_PROXY_TARGET` can stay set; the rewrite is unused once the frontend calls the backend directly. Users sign in once more.

## Target configuration

| Piece | Example |
|---|---|
| Frontend | `https://app.example.com` |
| Backend | `https://api.example.com` |
| Cookie domain | `.example.com` |

Use the real approved domain values for the environment; the examples are not deployment credentials.

## Cutover

1. Add the frontend custom domain to the Vercel project.
2. Add the backend custom domain to the Render service.
3. Set backend `FRONTEND_URL`, `GITHUB_CALLBACK_URL`, `SESSION_COOKIE_DOMAIN`, `ALLOWED_ORIGINS`, and `SESSION_SECURE` to the approved values.
4. Set frontend `NEXT_PUBLIC_API_BASE_URL` to the backend custom domain.
5. Update the GitHub OAuth App callback URL to exactly match `GITHUB_CALLBACK_URL`.
6. If the Vercel rewrite bridge is enabled, remove it: unset frontend `API_PROXY_TARGET` and backend `TRUST_PROXY_HOPS` (back to the default 1). Keep `SESSION_COOKIE_SAMESITE=lax`; the subdomains are same-site.
7. Redeploy both services so configuration is loaded.

The backend reads `SESSION_COOKIE_DOMAIN` and applies it to the session cookie. When unset, the cookie remains host-only.

## Verification

1. Test the GitHub login flow on Safari or an iPhone.
2. Confirm the redirect lands on the authenticated home page.
3. Inspect browser storage and confirm the session cookie has the approved parent domain, `Secure`, and the expected `SameSite` value.
4. Confirm CORS allows only the approved frontend origin.
5. Test the stable custom domain rather than a dynamic preview hostname for OAuth.

Record DNS, provider deployment, OAuth callback, browser, and result evidence.
