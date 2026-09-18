---
type: "Design Specification"
title: "EDU authentication migration into Golden Copy"
description: "Proposed phase-one boundary for migrating the EDU authentication experience without changing SaaS or Enterprise authentication."
tags: [design, edu, authentication, supabase, composition]
status: stable
---

# EDU authentication migration into Golden Copy

**Date:** 2026-09-18  
**Status:** Local implementation present; live Supabase, GitHub, and database verification remains environment-dependent  
**Backend checkout:** branch `codex/edu-auth-migration`  
**Frontend checkout:** branch `codex/edu-auth-migration`  
**Implementation branch:** `codex/edu-auth-migration` in both checkouts

## 1. Objective and completion boundary

Migrate the approved EDU authentication experience from the source EDU repositories
into Golden Copy as a tested, documented phase-one slice. The migration must preserve:

- separate student and staff sign-in doors;
- school-email-restricted student signup;
- password reset and password completion from Supabase recovery tokens;
- staff GitHub account linking, without turning GitHub into the EDU credential
  provider;
- server-authoritative lab listing and lab selection;
- the existing SaaS self-serve email/Google authentication behavior; and
- the existing Enterprise GitHub/internal-admission behavior.

The backend remains the owner of authentication policy and session state. Supabase
Auth remains the EDU credential and recovery provider behind a backend adapter. The
browser never receives Supabase service credentials and never calls Supabase directly.

The recommended phase-one boundary was approved for local implementation. This
document records the chosen defaults, implementation boundary, rejected
shortcuts, and verification limits. It does not claim that live provider or
roster migration work has completed.

## 1.1 Approved phase-one decisions

- Add the distinct `identity.edu-auth` capability; keep
  `identity.edu-provisioning` deferred for SIS/LMS and roster automation.
- Use dedicated `identity.edu_profiles`, `identity.edu_labs`, and
  `identity.edu_lab_memberships` tables rather than overloading generic
  workspace roles or `app_users.metadata`.
- Use source-compatible EDU URLs only in the `edu` edition and keep SaaS
  `/login`/`/signup` plus Enterprise auth unchanged.
- Use separate `hosted-saas` and `hosted-edu` physical build profiles. The
  previous combined hosted ceiling is not sufficient for source exclusion.
- Treat school-domain JIT signup as opt-in and default it off until a roster/lab
  seed is verified.
- Use a separate EDU Supabase project/configuration and a separate EDU GitHub
  OAuth app. Phase one stores only a durable GitHub identity link and status;
  future repository/lab operations require a separate token-storage decision.
- Do not attach an EDU Supabase subject to a SaaS or Enterprise account by email
  alone.

## 2. Evidence inspected

The authoritative isolated checkouts were verified clean on `codex/edu-auth-migration`
before inspection. The source EDU repositories were also clean on `main`.

| Area | Current evidence | Consequence |
|---|---|---|
| EDU frontend | `src/app/signin/*`, `src/app/auth/reset-password`, and `src/app/connect-github` preserve the student/staff doors, signup, recovery, GitHub linking, and lab switcher. | Port behavior into Golden Copy feature-sliced MVVM; do not copy the source route tree verbatim. |
| EDU backend | `AuthService` uses raw Supabase GoTrue REST, session cookies plus a signed bearer compatibility token, wrong-door audience checks, JIT student provisioning, GitHub linking, and selected-lab session state. | The adapter/policy boundary is real and can be ported without adding a browser Supabase SDK. |
| Golden Copy frontend | `src/features/auth/login`, `self-serve`, `session`, and `callback` already own the Enterprise and SaaS flows. Routes are thin and `src/shared/api/request.ts` uses HTTP-only session cookies. | Add isolated EDU slices and thin EDU routes; leave current auth feature behavior unchanged. |
| Golden Copy backend | `identity-access` owns `AuthController`, `AuthService`, `SelfServeAuthService`, shared session lookup, `identity.app_users`, and `identity.user_identities`. | Add an EDU application slice inside the existing identity context, not a second auth module or separately deployed service. |
| Composition | `identity.edu-provisioning` exists but is `not-implemented`; `identity.self-serve-auth` is SaaS-only. The frontend package is vendored from the backend catalog. | The EDU capability must be authored in the backend source catalog and regenerated into both repositories. SaaS and Enterprise records must not be changed accidentally. |
| Identity/lab storage | Golden Copy has generic `app_users`, linked identities, and team workspaces. It does not have EDU roles, lab GitHub metadata, course-derived access, or selected-lab session state. | A workspace reuse decision is required; the source EDU role/lab model cannot be represented by the current workspace contract alone. |
| Build profiles | `hosted-saas`, `hosted-edu`, and `enterprise` each resolve one pack ceiling. | The profile conformance gate can scan the SaaS artifact for the EDU auth source tree and the EDU artifact for SaaS/Enterprise roots. |

The requested Luna-max read-only audits were attempted with disjoint frontend and
backend scopes. Both were unavailable because the provider returned a 502/DNS
failure. No repository was modified by those attempts; the design below is based on
direct inspection of the four authoritative repositories.

## 3. Non-negotiable invariants

1. `alphaci-golden-copy-be` and `alphaci-golden-copy-fe` are the only implementation
   roots. The generated projectless directory is not edited.
2. No push, pull request, merge, or `main` modification is in scope.
3. Existing SaaS routes (`/auth/email/*`, `/auth/google/*`, `/login`, `/signup`) and
   Enterprise routes (`/auth/github/*`, internal admission, account lifecycle) keep
   their current services, providers, payloads, and capability key.
4. EDU routes are capability-gated and edition-gated. A SaaS or Enterprise request
   must not be able to invoke an EDU authentication handler or obtain an EDU role/lab
   response.
5. Supabase passwords, recovery tokens, and service credentials remain outside the
   Golden Copy database and browser. Golden Copy stores only the minimum subject/link
   and application authorization data needed to establish its own session.
6. A Supabase subject is bound to a Golden Copy user by an explicit, immutable
   provider identity. An email match alone must not attach an EDU credential to an
   unrelated SaaS or Enterprise account.
7. Lab access is an authorization decision. Client-provided lab IDs are never trusted;
   the server validates access and persists the selected lab in the session.

## 4. Recommended architecture

### 4.1 Capability boundary

The recommendation is to add a distinct `identity.edu-auth` capability rather than
repurpose `identity.edu-provisioning`. Authentication, recovery, and staff GitHub
linking are a user-facing identity boundary; future SIS/LMS/invite provisioning can
then mature independently. The new record would be:

- context: `identity-access`;
- maturity: `limited` for phase one;
- edition: `edu` only;
- configuration flag: `auth.eduAuthEnabled`;
- surface: the EDU auth route set and the EDU feature barrels; and
- dependencies: none until the storage decision is made.

The existing `identity.edu-provisioning` record remains `not-implemented` unless
the user explicitly chooses to treat phase-one school-email JIT provisioning as the
whole provisioning capability. That alternative is smaller, but it couples a future
provisioning promise to a login screen and makes the capability matrix misleading.

The capability source remains `src/kernel/composition/catalog.source.json`. Generated
backend registry/manifests/package output and frontend vendor/snapshot/surface files
must be regenerated, never hand-edited. SaaS `identity.self-serve-auth` remains
unchanged.

### 4.2 Backend application boundary

Add an EDU slice below the existing identity-access auth composition, for example:

```text
src/modules/identity-access/auth/edu/
  api/
  application/
  infrastructure/
  model/
```

The slice should contain:

- `EduAuthController` under `/api/v1/auth/edu`, with an explicit capability guard on
  every EDU handler;
- `EduAuthService` for audience checks, signup policy, recovery, session establishment,
  staff GitHub linking, and lab selection;
- an `EDU_SUPABASE_AUTH` port and a server-side raw REST adapter for GoTrue;
- an `EDU_GITHUB_OAUTH` port/configuration separate from the Enterprise GitHub
  admission and repository provider; and
- repositories for the chosen EDU profile/lab model and Supabase subject binding.

The existing shared session lookup remains unchanged for SaaS and Enterprise. An EDU login sets the
generic `req.session.userId` to the Golden Copy `app_users.id`, then adds EDU-only
session data such as role and selected lab. The generic `/auth/me` response is not
expanded for EDU; a separate protected `/auth/edu/me` contract carries EDU role,
accessible labs, and selected lab. This avoids changing the SaaS/Enterprise wire
contract while giving the EDU frontend the source behavior it needs.

The implemented phase-one public API shape is:

| Endpoint | Purpose |
|---|---|
| `POST /auth/edu/login` | Password sign-in with `STUDENT` or `STAFF` audience; returns the Golden Copy user and EDU session summary. |
| `POST /auth/edu/student/signup` | School-email validation and Supabase signup; does not store a password locally. |
| `POST /auth/edu/request-password-reset` | Enumeration-safe recovery request. |
| `POST /auth/edu/complete-password-reset` | Completes a Supabase recovery flow with a one-time access token. |
| `GET /auth/edu/me` | Current EDU user, role, labs, selected lab, and GitHub-link status. |
| `GET /auth/edu/labs` | Accessible labs and current selection. |
| `POST /auth/edu/select-lab` | Validated lab selection in the current session. |
| `GET /auth/edu/github/start` and `GET /auth/edu/github/callback` | Staff-only account linking, isolated from Enterprise GitHub login. |
| `POST /auth/edu/logout` or the shared logout contract | Clears the EDU session without changing existing logout semantics. |

The implementation keeps `WRONG_SIGN_IN_DOOR`, enumeration-safe reset success,
rate-limit errors, and unconfigured-provider responses as explicit contracts.
The frontend transport adapter maps the backend's `fullName`, `selectedOrgId`,
and `githubOrgName` fields into its existing `name`, `selectedLabId`, and lab
code model without leaking that mapping into views.

### 4.3 Identity and storage

The preferred binding is to extend the generic linked-identity repository with a
`supabase` provider and store the Supabase `auth.users.id` as `provider_user_id`.
That keeps the credential provider behind a port and avoids adding an `auth_user_id`
column to the generic core user table. The migration must preserve the existing
provider/password-hash constraints and must not make a Supabase identity visible to
SaaS self-serve code.

For EDU authorization, the preferred phase-one schema is dedicated identity-context
data for:

- an EDU profile with the source role (`STUDENT`, `TEACHER`, `ADMIN`, or
  `SUPER_ADMIN`);
- EDU lab metadata, including any GitHub organization identifier needed for the
  source policy; and
- explicit profile-to-lab memberships with an auditable role/source.

This is preferred over storing role/lab state in `app_users.metadata` or forcing the
source model into `orgs.workspaces`, whose role union and `kind = 'team'` contract do
not represent the EDU semantics. The table names and whether an existing EDU data
set must be imported are open decisions below.

### 4.4 Frontend composition

Add EDU-specific feature slices under the existing feature-sliced MVVM boundary:

```text
src/features/auth/edu-signin/
src/features/auth/edu-signup/
src/features/auth/edu-password-recovery/
src/features/auth/edu-connect-github/
src/features/auth/edu-labs/
src/features/auth/edu-session/
```

Each slice owns its model, HTTP data adapter, view-model, view, and barrel. Views do
not fetch directly. The EDU session slice uses `credentials: "include"` and the new
EDU session contract; it must not mutate the current SaaS/Enterprise session model
or attach a browser bearer token.

Thin route files preserve the source-compatible EDU URLs when
`BUILD_EDITION === "edu"`:

- `/signin` and `/signin/student` -> student sign-in;
- `/signin/staff` -> staff sign-in;
- `/signin/create-account` -> student signup;
- `/signin/forgot-password` -> recovery request;
- `/auth/reset-password` -> password completion;
- `/connect-github` -> staff account linking and skip flow.

Non-EDU builds redirect or fail closed to the existing `/login` behavior. The exact
non-EDU route policy is part of the build-profile decision; adding a conditional
route import alone does not prove source exclusion.

### 4.5 GitHub linking

EDU staff linking must use distinct `EDU_GITHUB_CLIENT_*`, callback, scope, and
encryption/token-storage configuration. The Enterprise `GITHUB_*` client, admission
policy, OAuth state, and repository-access token must not be reused by the EDU flow.

The minimal phase-one link is a durable linked GitHub identity plus a safe
connection-status response. If later EDU lab operations require a reusable GitHub
access token, that token needs an explicit server-side vault/session contract and
scope review; it must not be placed in the browser or `app_users.metadata`.

## 5. Alternatives considered

| Option | Assessment |
|---|---|
| A. New `identity.edu-auth`, isolated auth slice, Supabase adapter, dedicated EDU authorization data | Recommended. Preserves the three auth boundaries and gives roles/labs a truthful owner. |
| B. Reuse `identity.edu-provisioning`, `SelfServeAuthService`, and generic workspaces | Smaller diff, but conflates credential providers, audience doors, and EDU roles with SaaS/workspace roles. Not recommended without an explicit acceptance of those trade-offs. |
| C. Transplant the source EDU controller/session/database model wholesale | Rejected. It creates a second identity/session system and violates Golden Copy context, catalog, and feature-slice contracts. |

## 6. Deferred decisions for later phases

These are intentionally deferred rather than silently decided by the phase-one
slice:

1. **Roster source and import:** identify the authoritative EDU roster/lab source
   and define an idempotent import/backfill. Local seed rows are not production
   roster evidence.
2. **SIS/LMS provisioning:** define the provider, invite lifecycle, deprovisioning,
   and audit requirements before maturing `identity.edu-provisioning`.
3. **GitHub operations:** decide whether future lab operations need a vault-backed
   token, which scopes are justified, and how revocation is surfaced.
4. **Live provider topology:** confirm the Supabase project, callback allow-list,
   GitHub OAuth app, deployment origin, and session-store topology per environment.
5. **Cross-edition migration:** define an explicit, auditable account-linking
   process if one person must share identity across EDU and SaaS/Enterprise.

## 7. Completion boundary

Phase one is complete only when the local implementation and focused checks pass,
the profile/capability artifacts are consistent, and the remaining live-provider
and roster evidence is called out separately. A green static check does not prove
that Supabase email delivery, GitHub OAuth, database migration, browser cookies,
or production roster data work.
