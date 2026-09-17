---
type: "Design Specification"
title: "Golden Copy composition design"
description: "Design for promoting SaaS, EDU, and Enterprise composition packs from documentation into build and runtime composition."
tags: [design, composition, capabilities, packs]
status: implemented
---
# Golden Copy composition design

**Date:** 2026-09-11
**Status:** Implemented locally on `codex/golden-copy-trunk`; not pushed
**Branch:** `codex/golden-copy-trunk` (backend and frontend)

## 1. Problem

The Golden Copy contract layer already exists: a 29-key capability registry, three
comparable pack profiles, six architecture decisions, generated maps, and CI gates
that check capability records against `AppConfig` in both directions.

Before this implementation, execution did not exist. Every pack profile recorded
`Documentation status: documentation-only` and stated that no pack-selection resolver
was implemented. `identity.edition-entitlements` remains `not-implemented` for all three
packs, while the declared composition boundary is now enforced by the kernel, guards,
profile checks, and generated catalog contract.

This design promotes the registry from a documentation artifact into the source the
application builds and boots from, and makes pack membership a property that build
artifacts and running requests actually honour.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | The Enterprise repositories are the trunk. SaaS migrates onto them later, capability by capability. The trunk may be renamed. |
| D2 | Edition resolution supports both per-deployment and per-tenant modes, exposed through a single request-scoped API so callers never branch on mode. |
| D3 | EDU stays a declared pack. It must be expressible and provably empty; no LMS, LTI, cohort, or FERPA work is in scope. |
| D4 | Composition resolution is kernel-owned. Subscription entitlement stays in billing. They compose as two guards, not one. |
| D5 | A capability outside the pack returns 404. A capability inside the pack but not entitled reaches Billing's existing 402 response. |
| D6 | `/api/v1/capabilities` keeps its current wire shape and gains `edition` plus a capability key array. No v2 endpoint. |
| D7 | Build artifacts physically exclude code for packs they do not contain. |
| D8 | Manifest loading goes through one replaceable seam. No licence verification now; a signed source can drop in later without touching call sites. |
| D9 | Per-profile CI conformance: boot each profile, assert the resolved set equals the pack table, and scan build output for excluded packs' symbols. |

## 3. Build profiles are sets of packs

A build profile is not a pack. It is the set of packs compiled into one artifact.
This is what reconciles D2 with D7.

| Profile | Packs | Tenancy | Edition resolved from |
|---|---|---|---|
| `hosted` | saas, edu | multi-tenant | per-tenant |
| `enterprise` | enterprise | single-tenant per deployment | environment, at boot |

The profile is the ceiling. No later layer can enable a capability whose pack was not
compiled in, which is the existing narrowing rule expressed at build time.

## 4. Capability resolution

### 4.1 Narrowing

The capability *set* is narrowed by four layers, in order:

```text
build profile          packs compiled into this artifact (ceiling)
  -> edition manifest  capabilities declared for the resolved pack
  -> deployment config all of a capability's configurationFlags are true
  -> tenant override   a tenant may disable, never enable
```

A capability is then dropped if its `requires` closure is not satisfied.

Subscription entitlement is deliberately **not** a narrowing layer. It is a
per-request authorization decision applied after resolution, which is why it stays a
separate guard owned by billing rather than folding into the composition model.

### 4.2 The requires closure removes duplicated truth

`capabilities.controller.ts` currently hand-codes
`previewDeployments.enabled && deploymentHistory.enabled`, while the same fact is
already declared as a `requires` edge in the registry. The closure makes the
hand-coded form redundant. This pattern repeats as capabilities grow, so deriving it
is the point, not a cleanup.

### 4.3 Interface

```ts
// src/kernel/composition/capability-resolver.port.ts
export const CAPABILITY_RESOLVER = Symbol('CAPABILITY_RESOLVER');

export interface CapabilityResolverPort {
  /** Subject-scoped. Hosted narrows by tenant; enterprise ignores the subject. */
  for(subject: CompositionSubject): CapabilitySet;
  /** No subject. The deployment's own composition, for anonymous callers. */
  deployment(): CapabilitySet;
}
```

Resolution is pure set arithmetic. No `edition === '...'` branch may appear, and
`scripts/check-documentation.cjs` already enforces that.

The kernel placement is legitimate under boundary rule 3: composition data imports no
bounded context. It mirrors the existing `subscription.guard.ts` plus
`subscription-access.port.ts` pair already living in `src/kernel/auth/`.

## 5. Enforcement

### 5.1 Guard ordering is load-bearing

```ts
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
```

`CapabilityGuard` must precede `SubscriptionGuard`. If it does not, an unentitled
user hitting an out-of-pack capability reaches Billing before composition can hide
the capability. This ordering is pinned by an integration test; an in-pack but
unentitled request preserves Billing's existing 402 response.

`SessionAuthGuard` comes first because subject-scoped resolution needs the tenant.

### 5.2 The 404 convention already exists

`src/modules/runtime/api/env-feature.guard.ts` already throws `NotFoundException`
when a capability flag is off. `CapabilityGuard` generalises it, and `EnvFeatureGuard`
is deleted when it lands.

### 5.3 What does not migrate

A grep for `.enabled` returns roughly 45 hits. Most must be left alone:

- Provider `config.enabled` in the GCP, Render, and Vercel adapters is provider-pack
  availability, guarded by `check-provider-encapsulation.cjs`. Routing it through the
  resolver would break that boundary.
- `request.enabled` in `deployment-provisioning.policy.ts` and similar is a request
  DTO field.
- `session.secure` and `subscription.mockEnabled` are already declared
  non-capabilities in `NON_CAPABILITY_FLAGS`.

The genuine set is about a dozen call sites across nine files. Classifying each one is
part of the work.

### 5.4 The endpoint must be derived

`capabilities.controller.ts` reads `AppConfig` directly today. If the guard reads the
resolver and the endpoint reads config, they can disagree and the UI will render a
feature the guard then rejects. The controller is rewritten to project the resolved
set into the existing shape, pinned by a snapshot test that proves the response is
byte-identical for the default configuration.

`/api/v1/capabilities` has no guard today; only `ThrottlerGuard` is global. The
subjectless `deployment()` path serves anonymous callers. This is safe because the
artifact already excludes other packs entirely.

## 6. Frontend

### 6.1 Exclusion derives from existing data

`docs/capabilities/surface-registry.ts` already maps each capability key to its
`domains` and `routes`. Exclusion therefore derives from declared data that is already
maintained:

```text
build profile -> pack set -> capability set -> surface registry -> feature slices compiled in
```

No new folder structure, no route tree changes, no edition folders.

### 6.2 Conflict with frontend ADR-0003

Frontend ADR-0003 lists "Pack-specific route trees or edition folders" as a rejected
alternative. That rejection targets **duplication**: parallel trees and copied
screens. This design performs **exclusion**: one tree, one copy of every screen, and a
build that omits some. The distinction is real but is not what the ADR says, so it
requires an explicit amendment rather than a quiet reinterpretation.

### 6.3 Mechanism and its known limit

Excluded feature barrels are replaced at build time with a stub calling `notFound()`,
letting tree-shaking drop the slice. Routes keep importing from the barrel and
`src/app` is untouched.

**Known limit:** route paths still appear in the build manifest. The implementation
does not ship; the path string does. Removing names entirely requires pruning the
route tree before `next build`, which means either a dirty working tree or an
archive-to-scratch build. Accepted as a tradeoff. Revisit only if Enterprise route
names are themselves classified.

## 7. Cross-repo catalog contract

`sync-catalog-snapshot.cjs` resolves the backend registry through a **sibling
checkout**. It only works when both repositories sit next to each other on a
developer's disk, so CI cannot enforce it. Nothing today prevents
`catalog.snapshot.json` from drifting from the backend registry, despite frontend
ADR-0003 requiring them to match.

The backend publishes the catalog as a small versioned package. The frontend depends
on it, drift becomes a dependency bump with a reviewable diff, and it works in both
CIs. This is also the natural home for shared contracts when SaaS migrates onto the
trunk.

## 8. Conformance

Per profile, in both repositories:

1. Build the profile.
2. Boot it and read the capability surface.
3. Assert it equals the generated pack table.
4. Scan build output for excluded packs' symbols.

Step 4 is the enforcement of D7. Without it, exclusion is an intention rather than a
property.

## 9. Documentation and decision impact

Decisions land **before** code. Status documents land **with** the code that makes them
true.

A decision record is current-state the moment it is accepted, so new ADRs and the
amendments that remove contradictions can land first. Documents that describe what the
product currently does - the capability contract, the three pack profiles, the pack
contract's status vocabulary, the executive report, and the generated matrix - must not
change until the resolver and profiles exist. Changing them earlier replaces a true
statement with a false one and breaches the constitution's current-state rule.

**Backend**

- `docs/constitution.md`: the narrowing order, and the claim that runtime capability
  behaviour stays in the existing implementation.
- ADR-0002: amend the narrowing order and make build profile an explicit layer. The
  core decision, that axes are orthogonal, still holds.
- ADR-0003: its consequence that the registry "does not implement runtime entitlement
  resolution" is superseded. ADR-0003 already anticipated this by requiring a separate
  decision, so it gains a pointer rather than being rewritten.
- New ADR-0007: runtime composition resolution.
- New ADR-0008: build profiles and artifact exclusion.
- `docs/capabilities/capability-contract.md`: the claims that capability keys are
  documentation identifiers and that the registry is separate from the live response
  both become false.
- `docs/packs/pack-contract.md` and the three pack profiles: `documentation-only`
  status is retired for resolved packs; profiles become generated from manifests.
- `docs/executive/golden-copy-executive-report.md`: pack status and the
  not-implemented list.

**Frontend**

- ADR-0003: amend the rejected alternative to separate duplication from exclusion.
- New ADR: build-profile exclusion and the catalog package dependency.
- Pack profiles and executive report, mirroring the backend.

**Generated** artifacts are regenerated, never hand-edited.

**Verification tooling**

- `check-capabilities.cjs` parses `registry.ts` with a regex. When the registry moves
  into `src/`, the gate must import the module instead, or file formatting becomes
  load-bearing.
- `check-okf-bundle.cjs` in the backend lacks the frontend's `superpowers` directory
  skip, so dated design specs fail the canonical-documentation gate.

## 10. Sequencing

Each step is behaviour-neutral and independently revertable.

| PR | Content |
|---|---|
| 0 | New ADRs and contradiction-removing amendments only. No status flips, no code. |
| 1 | Registry moves to `src/kernel/composition/`. Manifests, resolver, requires closure. Nothing consumes it. Tests prove it reproduces today's set exactly. |
| 2 | Controller projects from the resolver. Snapshot test proves an identical response. |
| 3 | `CapabilityGuard` lands, `EnvFeatureGuard` is deleted, controller-level checks migrate. |
| 4 | Service-level `enabled()` helpers migrate onto the injected port. |
| 5 | Build profiles, artifact exclusion, and the conformance matrix. |
| 6 | Frontend exclusion and the catalog package. |
| 7 | Tenant override and the licence seam, if required. |

Steps 1 through 6 change no product behaviour. That property is what makes them
reviewable in isolation.

## 11. Out of scope

EDU capability implementation, SSO and SCIM, self-serve checkout, GitHub Enterprise
Server, managed secrets, air-gap packaging, data residency, customer isolation, and
the SaaS migration itself. Each is ordinary capability work once the composition layer
exists.

## 12. Open risks

- The SaaS-only code that must stay out of the Enterprise artifact barely exists yet;
  the payment gateway was already removed. The exclusion seam stays close to empty
  until SaaS migrates in, so its value is deferred.
- Hosted-profile backend exclusion is hygiene, not a security control. The hosted
  backend never ships to customers. This must not be presented as a customer-facing
  guarantee.
- Route-name visibility in the frontend build manifest, per section 6.3.
