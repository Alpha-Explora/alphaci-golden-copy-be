# EDU authentication migration into Golden Copy — implementation plan

> **Status:** Implemented and locally verified. Live provider/database evidence remains deferred, and the pre-existing frontend CSS warning threshold is still over its configured limit (743 warnings versus 742 allowed).

## Goal

Deliver a tested, documented phase-one EDU authentication slice across these
authoritative local checkouts:

- Backend: the backend checkout on branch `codex/edu-auth-migration`
- Frontend: the frontend checkout on branch `codex/edu-auth-migration`

Preserve Supabase Auth as the EDU credential/recovery provider behind a backend
adapter and policy, preserve SaaS self-serve and Enterprise GitHub/internal auth,
preserve source EDU behavior, keep cross-edition identity boundaries explicit, and
leave all work local. Do not push, create a PR, merge, or modify `main`.

The plan follows the approved design: a new `identity.edu-auth` capability,
dedicated EDU authorization data, source-compatible EDU URLs, isolated EDU GitHub
configuration, and separate `hosted-saas`/`hosted-edu` artifact profiles.

## Task 0 — Freeze the approved contract before implementation

**Files:**

- Read: the companion EDU authentication design specification in the backend checkout.
- Read: source EDU FE/BE auth files already audited.

**Actions:**

- Record the answers to the eight contract questions in the design document or an
  approved follow-up decision record.
- Confirm the database source for EDU staff/lab rows and the test fixture strategy.
- Confirm whether “EDU and Enterprise code out of SaaS” means runtime/capability
  isolation or physically separate hosted artifacts.
- Re-run `git status --short --branch` and `git rev-parse --show-toplevel` in both
  exact checkouts immediately before editing.

**Gate:** approved. The capability, dedicated lab model, source-compatible URLs,
separate Supabase/GitHub configuration, and strict profile isolation are recorded
in the companion design spec. Roster import and future token storage remain
deferred decisions.

## Task 1 — Add the backend capability and configuration contract

**Backend files:**

- Modify `src/kernel/composition/catalog.source.json` with the approved EDU auth
  record and its surface metadata.
- Modify `src/kernel/config/app.config.types.ts` to add the EDU auth/config and,
  if approved, separate EDU GitHub/Supabase configuration types.
- Modify `src/kernel/config/app.config-slices.ts` and `src/kernel/config/app.config.ts`
  to make EDU configuration explicit and fail closed when `ALPHACI_EDITION` is not
  `edu`.
- Modify `src/types/express-session.d.ts` with narrowly named EDU session fields;
  do not overload Enterprise `githubAccessToken`.
- Regenerate, do not hand-edit, `src/kernel/composition/capability-registry.ts`,
  `src/kernel/composition/manifests.ts`, and `packages/capability-catalog/*`.
- Update `docs/capabilities/ledger.json` through the repository ledger helper and
  regenerate capability matrices, pack maps, and architecture maps.
- Update `.env.example` and the EDU configuration/runbook documentation with names,
  defaults, redirect allow-lists, and secret-handling rules.

**Frontend files:**

- Refresh `vendor/@alphaci/capability-catalog/*` from the backend package artifact.
- Regenerate `docs/capabilities/catalog.snapshot.json`,
  `docs/capabilities/surface-registry.ts`, and the generated capability matrix.
- Update `docs/packs/edu/pack.md` to describe limited phase-one auth and its
  unsupported provisioning/data-import boundaries.
- Keep the SaaS pack row for `identity.self-serve-auth` unchanged.
- If strict artifact isolation is approved, modify `scripts/run-edition.mjs`,
  `scripts/lib/capability-profile.cjs`, build-profile declarations, and the paired
  backend composition profile so SaaS and EDU hosted artifacts have distinct
  ceilings. Add profile tests before relying on the new profile.

**Tests:**

- Extend backend composition-source, capability-package, capability-ledger, and
  capability-composition tests for the new record and edition membership.
- Extend frontend package/provenance, capability, profile, and documentation tests.
- Add a regression assertion that SaaS self-serve and Enterprise GitHub keys/routes
  remain unchanged.

**Status:** implemented and locally verified; capability, ledger, composition-source,
architecture-map, documentation, and all three compiled build-profile checks pass.

## Task 2 — Add EDU identity and lab persistence

**Backend files:**

- Create the next ordered migration under
  `supabase/migrations/identity-access/` for the approved provider binding and EDU
  profile/lab/membership tables.
- Modify `src/modules/identity-access/auth/infrastructure/user-identities.repository.ts`
  to support the approved `supabase` identity provider without allowing identity
  reassignment or password-hash storage for that provider.
- Modify `src/modules/identity-access/auth/auth-identity.module.ts` only to register
  the new EDU repositories through narrow exports.
- Create EDU repositories under
  `src/modules/identity-access/auth/edu/infrastructure/` for subject lookup,
  profile/role, lab access, and selected-lab persistence.
- Add schema-ownership and repository tests for unique provider subjects, archived
  users, lowercased school emails, explicit membership, and selected-lab access.

**Rules:**

- Never attach a Supabase subject to a user solely because the email matches a
  different edition account.
- Do not put EDU roles, lab membership, GitHub organization identifiers, or tokens
  in `identity.app_users.metadata`.
- Do not modify generic workspace role semantics unless the user explicitly chose
  workspace reuse in Task 0.

**Status:** implemented locally with the ordered migration and dedicated
repository; production roster import remains deferred.

## Task 3 — Implement the server-side Supabase adapter and EDU application service

**Backend files:**

- Create `src/modules/identity-access/auth/edu/model/edu-auth.types.ts` and policy
  contracts for `STUDENT`/`STAFF`, source roles, error codes, and lab summaries.
- Create `src/modules/identity-access/auth/edu/application/edu-supabase-auth.port.ts`
  and a raw REST adapter under `infrastructure/` for password verification, signup,
  recovery email, and password completion.
- Create `src/modules/identity-access/auth/edu/application/edu-auth.service.ts` for:
  - student/staff audience matching and wrong-door errors;
  - school-email domain and active-profile checks;
  - Supabase subject binding/JIT profile creation under the approved data rule;
  - session creation and destruction;
  - enumeration-safe recovery;
  - staff-only GitHub account linking; and
  - lab listing, first-lab selection, and validated switching.
- Create an isolated EDU GitHub OAuth port/adapter and token handling only if Task 0
  confirms that link credentials must be retained.
- Create `src/modules/identity-access/auth/edu/api/dto/` DTOs with whitelist/
  forbid-non-whitelisted validation.
- Create `src/modules/identity-access/auth/edu/api/edu-auth.controller.ts` under
  `/auth/edu`; apply `CapabilityGuard` plus `@RequiresCapability('identity.edu-auth')`
  to all EDU routes and `SessionAuthGuard` to protected routes.
- Register only the EDU providers/controller in the existing `AuthModule`; do not
  alter `AuthService`, `SelfServeAuthService`, Enterprise GitHub decorators, or
  admission-policy logic except for wiring that is mechanically required.

**Focused tests:**

- Supabase adapter tests for successful login, invalid credentials, unconfirmed
  email, rate limit, provider outage, signup, recovery, and expired/used reset token.
- Service tests for wrong-door behavior, school-domain rejection, JIT binding,
  existing-unbound-email takeover prevention, archived users, generic recovery,
  student GitHub-link rejection, staff link success, and lab access enforcement.
- Controller tests for every route's DTO, guard, capability metadata, status code,
  response envelope, and redirect allow-list.
- Session tests proving the generic lookup still works for SaaS/Enterprise and EDU,
  while EDU role/lab state is not returned by the generic `/auth/me` contract.

**Status:** implemented locally with adapter, service, repository, controller, and
focused policy/contract tests. Live provider/database execution remains pending.

## Task 4 — Port the EDU frontend into MVVM slices

**Frontend files:**

- Create `src/features/auth/edu-session/` with model/data/view-model/views and a
  barrel for `/auth/edu/me`, logout, current role, labs, and selected lab.
- Create `src/features/auth/edu-signin/` with separate student/staff audience state,
  validation, wrong-door routing, and source error behavior.
- Create `src/features/auth/edu-signup/` for school-email signup and confirmation.
- Create `src/features/auth/edu-password-recovery/` for request and fragment-token
  completion; strip the URL fragment after reading it as the source does.
- Create `src/features/auth/edu-connect-github/` for staff-only link/reconnect/skip.
- Create `src/features/auth/edu-labs/` for the accessible-lab switcher and selected
  lab state.
- Reuse only domain-free shared UI primitives. Keep EDU copy and orchestration in
  EDU feature slices; do not deep-import SaaS self-serve internals.
- Add thin route files at `src/app/signin/`, `src/app/auth/reset-password/`, and
  `src/app/connect-github/` that select the EDU feature barrels only for the EDU
  edition and preserve the existing `/login`, `/signup`, and callback routes.
- Add the approved EDU API base/config example without introducing a browser
  Supabase dependency or bearer storage.

**Focused tests:**

- View-model tests for each audience, validation/error mapping, success redirects,
  reset-token states, and GitHub-link guard behavior.
- Route tests for source-compatible paths in EDU and fail-closed behavior in SaaS /
  Enterprise.
- Component tests for accessible labels, keyboard flow, confirmation copy, and lab
  selection state.
- Boundary tests proving app routes import only feature barrels/shared modules and
  no EDU feature imports Enterprise or SaaS self-serve internals.

**Status:** implemented locally with EDU MVVM slices, thin routes, transport
mapping, and focused rule/API/boundary tests.

## Task 5 — Document operations and current-state status

**Files:**

- Update the approved design spec from `proposed` to the accurate implementation
  status only after the code and tests pass.
- Add an EDU auth runbook under `docs/runbooks/` covering required environment
  variables, Supabase redirect setup, GitHub callback setup, session-cookie/CORS
  requirements, school-domain configuration, lab roster setup, and recovery steps.
- Update `docs/architecture/current-architecture.md`, the auth feature map, the EDU
  pack, capability matrix, and change log with the implemented boundary and known
  limits.
- Record unavailable live Supabase/GitHub/database verification separately from local
  unit, architecture, and build evidence.

**Status:** runbook and current-state documentation added; generated-map,
generated-file, architecture, profile-build, and documentation checks pass. Live
Supabase, GitHub OAuth, database, cookie/CORS, and roster evidence remains
environment-dependent.

## Task 6 — Verify before claiming completion

**Status:** local verification completed on the isolated backend and frontend
checkouts. The full backend suite passed with 188 suites (1 skipped) and 1,805
tests (3 skipped); the full frontend suite passed with 70 suites and 648 tests.
Focused EDU/profile suites also pass. Typechecks, lint, production builds,
capability/profile/catalog checks, dependency boundaries, schema ownership,
provider encapsulation, generated maps, and documentation checks pass. The
frontend CSS gate remains a pre-existing repository-wide warning-threshold
failure: 743 warnings against a 742-warning limit, with no CSS files changed by
this migration.

Run from each exact checkout, not from the generated projectless directory.

**Backend minimum gates:**

```text
npm run typecheck
npm run lint
npm test -- --runInBand <focused EDU/auth and architecture suites>
npm run check:composition-source
npm run check:capabilities
npm run check:capability-package
npm run check:capability-ledger
npm run check:composition-profiles
npm run check:application-boundaries
npm run check:schema-ownership
npm run check:provider-encapsulation
npm run check:documentation
```

Run the backend build and HTTP boot/profile checks if the repository's current
dependencies permit them. A missing database, Supabase project, or GitHub OAuth
secret is an environment limitation, not a passing integration result.

**Frontend minimum gates:**

```text
npm run typecheck
npm run lint
npm run lint:css
npm run boundaries
npm run arch:check
npm test -- --runInBand <focused EDU/auth and route suites>
npm run check:capabilities
npm run check:capability-package
npm run check:profiles
npm run check:documentation
npm run build:saas
npm run build:edu
npm run build:enterprise
```

If strict artifact isolation is approved, scan each output for excluded EDU,
Enterprise, and SaaS symbols using the repository profile checker and record the
profile-specific evidence. Finish with `git diff --check`, a full diff review,
`git status --short --branch`, and separate local commits only if the user later
authorizes committing.
