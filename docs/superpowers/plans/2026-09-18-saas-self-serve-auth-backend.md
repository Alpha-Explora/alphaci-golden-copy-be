# SaaS Self-Serve Auth Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline execution with the existing backend test and verification commands. Steps use checkbox syntax for tracking.

**Goal:** Add the SaaS-only email and Google self-serve authentication slice while preserving Enterprise GitHub authentication and admission behavior.

**Architecture:** Keep the existing GitHub `AuthService` flow and `AdmissionPolicy` unchanged. Add a focused self-serve application service behind capability-guarded controller routes, using the existing `identity.user_identities`, `identity.email_verification_codes`, `identity.oauth_states`, and `identity.auth_session_handoffs` tables through repository adapters. Use injected Google OAuth, password hashing, email delivery, and session-handoff boundaries; bootstrap only the existing free entitlement after verified authentication.

**Tech Stack:** NestJS 11, Express sessions, PostgreSQL via `DatabaseService`, `class-validator`, Node `scrypt`, `google-auth-library`, Jest.

**Spec:** User request in the current task: approved SaaS self-serve auth backend slice.

## Global Constraints

- Touch only `C:\Users\anton\Codes\Alpha Explora\AlphaCi Enterprise\alphaci-enterprise-be`.
- Do not edit the frontend, commit, push, or create a PR.
- Preserve the existing GitHub OAuth flow and `AdmissionPolicy` behavior.
- Gate new self-serve routes with `identity.self-serve-auth` so Enterprise and EDU remain provider-only.
- Reuse existing identity/code/session-handoff migrations; do not add duplicate tables.
- Never return account-existence information from public email endpoints.
- Never claim email was sent without a configured provider; development may log codes explicitly, production must return a clean not-configured failure.

### Task 1: Add identity, code, session, password, Google, and email-delivery adapters

**Files:**
- Create: `src/modules/identity-access/auth/infrastructure/user-identities.repository.ts`
- Create: `src/modules/identity-access/auth/infrastructure/email-verification-codes.repository.ts`
- Create: `src/modules/identity-access/auth/infrastructure/auth-session-handoff.repository.ts`
- Create: `src/modules/identity-access/auth/application/password-hasher.service.ts`
- Create: `src/modules/identity-access/auth/application/email-code-template.service.ts`
- Create: `src/modules/identity-access/auth/application/email-code-delivery.service.ts`
- Create: `src/modules/identity-access/auth/application/google-oauth.port.ts`
- Create: `src/modules/identity-access/auth/infrastructure/google-oauth.client.ts`
- Modify: `src/modules/identity-access/auth/infrastructure/users.repository.ts`
- Modify: `src/modules/identity-access/auth/auth-identity.module.ts`
- Modify: `src/modules/identity-access/auth/auth.module.ts`

**Interfaces:**
- `UserIdentitiesRepository` reads and safely upserts email/Google identities without reassigning an existing provider identity to another user.
- `EmailVerificationCodesRepository` creates, reads, counts attempts, and consumes signup codes.
- `AuthSessionHandoffRepository` atomically claims one-time OAuth handoff payloads.
- `GOOGLE_OAUTH` exposes `isConfigured`, `authorizationUrl`, and verified profile exchange.
- `EmailCodeDeliveryService.ensureReady()` is safe to call before account lookups; `sendCode()` logs only in non-production development mode or calls configured Resend.

- [ ] Add adapters and focused adapter tests for hash verification, code persistence SQL, handoff deletion, Google claim verification, and delivery configuration.
- [ ] Add `UsersRepository.createFederatedUser` for email/Google accounts while retaining existing GitHub SQL and role/internal semantics.
- [ ] Register the new adapters with narrow exports from `AuthIdentityModule` and `AuthModule`.

### Task 2: Add self-serve application workflows

**Files:**
- Create: `src/modules/identity-access/auth/application/self-serve-auth.service.ts`
- Create: `src/modules/identity-access/auth/application/self-serve-auth.service.spec.ts`

**Interfaces:**
- `checkEmailSignupAvailability(email)` always returns the existing `{ ok: true, available: true }` contract without querying account existence.
- `startEmailSignup({ firstName, lastName, email, password })` returns `{ ok: true, verificationRequired: true }` for both new and already-known email requests; it creates/updates only an unverified pending identity and sends a code after delivery readiness is confirmed.
- `verifyEmailSignupCode(request, { email, code })` enforces five attempts, consumes the code, marks the identity verified, bootstraps the existing free entitlement, and regenerates/saves a session.
- `loginWithEmail(request, { email, password })` uses one generic unauthorized error for missing, archived, unverified, or wrong-password identities.
- `resendEmailSignupCode(email)` uses a generic response and checks delivery readiness before any identity lookup.
- `startGoogleAuth` and `handleGoogleCallback` use one-time DB state, verified Google ID tokens, verified-email linking, free entitlement bootstrap, session regeneration, and optional one-time session handoff.
- `claimSessionHandoff(request, token)` consumes exactly one authenticated handoff and establishes the session.

- [ ] Write service tests for enumeration-safe responses, code attempt limits, verification/session behavior, generic login failures, delivery-not-configured behavior, Google state/profile/linking, and one-time handoff claims.
- [ ] Implement the service with no billing checkout, no plan selection, and no new outbox topic.

### Task 3: Expose validated, throttled, SaaS-only routes and config

**Files:**
- Create: `src/modules/identity-access/auth/api/dto/email-auth.dto.ts`
- Create: `src/modules/identity-access/auth/api/dto/claim-session-handoff.dto.ts`
- Modify: `src/modules/identity-access/auth/api/auth.controller.ts`
- Modify: `src/modules/identity-access/auth/api/auth.controller.spec.ts`
- Modify: `src/kernel/config/app.config.types.ts`
- Modify: `src/kernel/config/app.config.ts`
- Modify: `src/kernel/config/env.validation.ts`
- Modify: `.env.example`
- Modify: `src/types/express-session.d.ts`

**Interfaces:**
- Add `POST /api/v1/auth/email/check`, `/email/signup`, `/email/verify-code`, `/email/login`, `/email/resend-code`.
- Add `GET /api/v1/auth/google/start`, `/google/callback` and `POST /api/v1/auth/session/claim`.
- Apply DTO validation, endpoint-specific throttles, and `CapabilityGuard` + `RequiresCapability('identity.self-serve-auth')` only to new routes.
- Keep existing GitHub route decorators and handlers behaviorally unchanged.

- [ ] Add DTO contract tests and controller delegation tests for every new route.
- [ ] Add optional Google and email-delivery config parsing/documentation without making Enterprise boot depend on SaaS credentials.
- [ ] Update session handoff typing for authenticated payloads without weakening cookie settings.

### Task 4: Verify the slice and inspect the complete patch

**Files:**
- Modify: none unless verification reveals a directly related issue.

- [ ] Run focused auth unit/controller/adapter tests.
- [ ] Run typecheck, build, lint for touched backend code, and the application-boundary check.
- [ ] Run capability/profile checks that prove the new routes are available only to SaaS composition.
- [ ] Inspect `git diff --check`, `git diff`, `git status`, and the changed-file list; report tests and blockers without claiming database/deployment verification that was not run.
