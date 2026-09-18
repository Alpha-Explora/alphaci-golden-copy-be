---
type: "Runbook"
title: "EDU authentication"
description: "Configure, operate, and recover the isolated EDU authentication slice."
tags: [runbook, edu, authentication, supabase, github]
status: stable
---
# EDU authentication runbook

This runbook covers the limited EDU authentication slice in the `hosted-edu`
artifact. It does not cover SIS/LMS provisioning, roster import automation, or
GitHub repository operations. Those are later phases and must not be inferred
from a successful sign-in.

## Boundary

- The backend owns the EDU policy, session cookie, Supabase subject binding, and
  lab authorization.
- Supabase Auth owns the EDU password and recovery token. The browser never
  receives a Supabase service key and does not call Supabase directly.
- `identity.edu_profiles`, `identity.edu_labs`, and
  `identity.edu_lab_memberships` are separate from SaaS self-serve identities
  and generic workspace roles.
- EDU GitHub linking records a durable identity/status only. Phase one does not
  retain a GitHub OAuth access token for future lab operations.

## Required composition

Run EDU with both values set explicitly:

```text
ALPHACI_BUILD_PROFILE=hosted-edu
ALPHACI_EDITION=edu
```

`hosted-saas` and `enterprise` physically exclude the EDU authentication source
tree. Do not enable an EDU edition against another profile; boot validation must
reject that combination.

## Environment

Set these on the backend only:

| Variable | Purpose |
|---|---|
| `AUTH_EDU_ENABLED` | Optional kill switch. Defaults enabled for the EDU edition; set `false` to return a fail-closed unavailable response. |
| `EDU_FRONTEND_URL` | Trusted frontend origin used for safe OAuth return URLs. |
| `EDU_SUPABASE_URL` | EDU Supabase project URL. |
| `EDU_SUPABASE_ANON_KEY` | Public Supabase API key used by the server-side GoTrue adapter; never use the service-role key in the browser. |
| `EDU_STUDENT_EMAIL_DOMAINS` | Comma-separated lower-case school domains. Student signup/JIT checks the full domain or a subdomain. |
| `EDU_STUDENT_JIT_PROVISIONING` | Keep `false` until the roster/lab seed is ready. Enables allowed-domain student JIT only. |
| `EDU_SUPABASE_PASSWORD_RESET_REDIRECT` | Exact HTTPS production recovery URL, normally `/auth/reset-password`. |
| `EDU_SUPABASE_SIGNUP_REDIRECT` | Exact confirmation URL, normally `/signin`. |
| `EDU_GITHUB_CLIENT_ID` / `EDU_GITHUB_CLIENT_SECRET` | Dedicated EDU GitHub OAuth app credentials. Do not reuse `GITHUB_*`. |
| `EDU_GITHUB_CALLBACK_URL` | Backend callback registered in the EDU GitHub OAuth app, normally `/api/v1/auth/edu/github/callback`. |
| `EDU_GITHUB_SCOPE` | Start with `read:user user:email`; add scopes only with a later lab-operation decision. |

The callback and redirect values are configuration, not user input. The service
accepts only same-origin frontend return URLs or safe relative paths.

## Supabase setup

1. Create or select the EDU Supabase project; do not point this at the SaaS
   project without an explicit identity-boundary decision.
2. Add the exact signup and password-recovery redirect URLs to the Supabase
   Auth allow-list.
3. Run the ordered migration
   `supabase/migrations/identity-access/20260918000000_edu_authentication.sql`.
4. Seed at least one active `identity.edu_labs` row and the corresponding staff
   membership/profile before testing lab selection.
5. Keep `EDU_STUDENT_JIT_PROVISIONING=false` until domain ownership, email
   confirmation, and the seed data are verified.

The migration stores a Supabase `auth.users.id` only in the explicit
`identity.user_identities` provider binding. It does not store passwords or
recovery tokens.

## GitHub setup

Create a separate GitHub OAuth App for EDU and register the exact backend
callback URL. The staff flow is:

1. A signed-in non-student requests `/api/v1/auth/edu/github/start`.
2. The backend stores a one-time state and safe return URL in the session.
3. GitHub returns to `/api/v1/auth/edu/github/callback`.
4. The backend validates state, fetches the profile, and stores the unique
   GitHub identity on the staff EDU profile.

Students are rejected by policy. A GitHub account already linked to another EDU
profile is rejected. No GitHub token is returned to the browser or persisted in
the phase-one session.

## Cookies and CORS

The frontend calls `/api/v1/auth/edu/*` with credentials included. Configure:

- `ALLOWED_ORIGINS` to contain the exact `EDU_FRONTEND_URL` origin;
- the existing `SESSION_SECRET` and selected session store for the deployment;
- HTTPS and secure cookie settings in production; and
- a shared parent domain or explicit cross-origin cookie policy only when the
  deployment genuinely needs it.

Do not solve a missing cookie by adding a browser bearer token. Check the browser
origin, CORS response, cookie `SameSite`/`Secure` attributes, and session-store
health first.

## Recovery and disablement

- Set `AUTH_EDU_ENABLED=false` to stop the EDU route surface without changing
  SaaS or Enterprise auth.
- If Supabase is unavailable, sign-in returns a service-unavailable response;
  recovery requests remain enumeration-safe.
- If a profile is suspended or archived, its session is rejected on the next
  protected request.
- If lab access changes, remove the membership or deactivate the lab; the
  server revalidates selection and clears an inaccessible session selection.
- If the GitHub link is wrong, remove the profile's GitHub identity through the
  controlled data-maintenance procedure and require a fresh state-validated link.

## Verification limits

Local composition, catalog, adapter, policy, repository, controller, and
frontend rule checks can run without external accounts. A real Supabase email,
GitHub callback, database migration, cookie exchange, and roster import require
deployment credentials and live services; record those as environment evidence,
not as passing local tests.
