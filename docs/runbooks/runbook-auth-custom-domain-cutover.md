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
4. Set frontend `NEXT_PUBLIC_API_URL` to the backend custom domain.
5. Update the GitHub OAuth App callback URL to exactly match `GITHUB_CALLBACK_URL`.
6. Redeploy both services so configuration is loaded.

The backend reads `SESSION_COOKIE_DOMAIN` and applies it to the session cookie. When unset, the cookie remains host-only.

## Verification

1. Test the GitHub login flow on Safari or an iPhone.
2. Confirm the redirect lands on the authenticated home page.
3. Inspect browser storage and confirm the session cookie has the approved parent domain, `Secure`, and the expected `SameSite` value.
4. Confirm CORS allows only the approved frontend origin.
5. Test the stable custom domain rather than a dynamic preview hostname for OAuth.

Record DNS, provider deployment, OAuth callback, browser, and result evidence.
