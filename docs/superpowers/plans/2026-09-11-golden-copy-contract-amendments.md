# Golden Copy Contract Amendments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the composition decisions as architecture decision records in both repositories so later code changes have a contract to implement against.

**Architecture:** Decisions only. Two new backend ADRs and one new frontend ADR capture runtime composition resolution and build-profile artifact exclusion. Existing ADRs gain supersession pointers rather than rewritten history. No status document flips to claim behaviour that does not exist yet.

**Tech Stack:** Markdown under the OKF documentation bundle, validated by Node gate scripts in each repository.

**Spec:** `docs/superpowers/specs/2026-09-11-golden-copy-composition-design.md`

## Global Constraints

- Work only on branch `codex/golden-copy-trunk`. Never commit to `main`.
- Two repositories are in scope. Backend: `alphaci-enterprise-be`. Frontend: `alphaci-enterprise-fe`.
- Canonical documentation is current-state only. A document that describes product status must not be changed until the code that makes it true lands.
- Document file names must match `^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9-]+)*\.md$`.
- Every markdown link must resolve inside the documentation bundle. A link to a directory requires that directory to contain `index.md`.
- `scripts/check-documentation.cjs` scans every file under `docs/`, including `superpowers/`, against `PROHIBITED_DOCUMENTATION_PATTERNS`. Read that list in the script before writing and avoid every term it names. The OKF frontmatter exemption for `superpowers/` does not exempt this scan.
- Every change that alters a documented contract updates `docs/log.md` and `CHANGELOG.md` in the same repository.
- `npm` may be unavailable. Run gates with `node` directly, as shown in each task.
- Do not modify `src/` in this plan. No production code changes belong to these tasks.

---

## Why this plan is smaller than the spec implies

Spec section 9 lists contract documents such as `capability-contract.md`, the three pack profiles, and the executive report as part of the first change. That is wrong, and this plan deliberately excludes them.

Those documents describe **current product status**. Amending them now would replace one false statement with another: today they claim no resolver exists, which is true; changing them before the resolver exists would claim it does, which is not. The constitution requires canonical documentation to be current-state only, and requires a contract change to travel with the source change that makes it true.

A decision record is different. An accepted decision is current-state the moment it is accepted, regardless of whether the code exists. That is the only category of document this plan touches.

---

## File Structure

**Backend (`alphaci-enterprise-be`)**

| File | Responsibility |
|---|---|
| `docs/architecture/decisions/adr-0007-runtime-composition-resolution.md` | Create. Records that capability resolution becomes kernel-owned runtime behaviour. |
| `docs/architecture/decisions/adr-0008-build-profiles-and-artifact-exclusion.md` | Create. Records that build artifacts exclude packs they do not contain. |
| `docs/architecture/decisions/adr-0002-orthogonal-product-axes.md` | Modify. Add a pointer to ADR-0007. |
| `docs/architecture/decisions/adr-0003-composition-packs-and-entitlements.md` | Modify. Add a pointer to ADR-0007 and ADR-0008. |
| `docs/architecture/decisions/index.md` | Modify. List the two new records. |
| `docs/log.md`, `CHANGELOG.md` | Modify. Record the change. |

**Frontend (`alphaci-enterprise-fe`)**

| File | Responsibility |
|---|---|
| `docs/architecture/decisions/adr-0003-shared-catalog-and-packs.md` | Modify. Separate rejected duplication from permitted exclusion. |
| `docs/architecture/decisions/adr-0004-build-profile-exclusion.md` | Create. Records build-profile exclusion and the catalog dependency. |
| `docs/architecture/decisions/index.md` | Modify. List the new record. |
| `docs/log.md`, `CHANGELOG.md` | Modify. Record the change. |

---

### Task 1: Unblock the documentation gate

**Files:**
- Move: `docs/architecture/saas-to-enterprise-backend-takeaways.md` -> `docs/superpowers/reports/saas-to-enterprise-backend-takeaways.md`

**Interfaces:**
- Consumes: the `superpowers` skip already present in `scripts/check-okf-bundle.cjs`.
- Produces: a green `check-okf-bundle` run, which every later task depends on.

This file is an untracked, dated review report that names local checkout paths. It is not current-state canonical documentation, so it fails the bundle gate and blocks every other task. `docs/superpowers/` is skipped by the gate and is the correct home for dated reports.

**If the file owner prefers to keep the path,** the alternative is adding OKF frontmatter to it. That may still fail because the report embeds absolute checkout paths, which canonical documentation forbids. Confirm the choice before moving.

- [ ] **Step 1: Reproduce the failure**

```bash
cd alphaci-enterprise-be
node scripts/check-okf-bundle.cjs docs
```

Expected: FAIL with `architecture/saas-to-enterprise-backend-takeaways.md: missing YAML frontmatter`

- [ ] **Step 2: Move the report**

```bash
mkdir -p docs/superpowers/reports
git mv -f docs/architecture/saas-to-enterprise-backend-takeaways.md docs/superpowers/reports/saas-to-enterprise-backend-takeaways.md 2>/dev/null || mv docs/architecture/saas-to-enterprise-backend-takeaways.md docs/superpowers/reports/saas-to-enterprise-backend-takeaways.md
```

- [ ] **Step 3: Verify the gate passes**

```bash
node scripts/check-okf-bundle.cjs docs
```

Expected: PASS, no errors reported.

- [ ] **Step 4: Check for a dangling link**

`docs/architecture/index.md` has an uncommitted modification that may link to the moved report. Run:

```bash
node scripts/check-documentation.cjs
```

If it reports `linked concept does not exist`, remove or repoint that link in `docs/architecture/index.md`, then rerun until it passes.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers docs/architecture scripts/check-okf-bundle.cjs
git commit -m "docs: move the SaaS-to-Enterprise review out of the canonical bundle"
```

---

### Task 2: Backend ADR-0007, runtime composition resolution

**Files:**
- Create: `docs/architecture/decisions/adr-0007-runtime-composition-resolution.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the decision that Task 4 links from ADR-0002 and ADR-0003, and that Task 3 references as the resolution model it constrains.

- [ ] **Step 1: Create the record**

Write exactly:

````markdown
---
type: "Decision"
title: "Runtime composition resolution"
description: "Resolve capability composition at runtime from a kernel-owned registry instead of documentation alone."
tags: [architecture, decision, composition, capabilities]
status: stable
timestamp: "2026-09-11T00:00:00Z"
sources:
  - id: capability-contract
    resource: "/capabilities/capability-contract.md"
    title: "Capability contract"
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Composition pack contract"
---
# ADR-0007: Runtime composition resolution

**Decision date:** 2026-09-11
**Decision status:** Accepted
**Scope:** Capability composition, entitlement, and the capability compatibility surface

## Decision

Capability composition is resolved at runtime by the technical kernel. The capability registry becomes an application source that the build and the running process read, and the generated documentation is derived from it rather than checked against it.

The resolved capability set is narrowed by four layers, in order:

```text
build profile        packs compiled into this artifact
  -> edition manifest      capabilities declared for the resolved pack
  -> deployment config     every configuration flag for the capability is true
  -> tenant override       a tenant may disable, never enable
```

A capability is dropped when its `requires` closure is unsatisfied.

Subscription entitlement is **not** a narrowing layer. It is a per-request authorization decision that stays owned by Billing and is applied after resolution. A capability absent from the resolved set is reported as not found. A capability present but unentitled is reported as forbidden. The composition check runs before the entitlement check so an unentitled caller cannot learn that an out-of-pack capability exists.

Resolution reads composition data only. It contains no edition comparison.

## Rejected alternatives

- Folding subscription entitlement into capability narrowing was rejected. It conflates what the product offers with what a caller has bought, and it would move billing policy into the kernel.
- Placing the resolver in `identity-access` was rejected. Composition is not identity behaviour, and other contexts would then depend on identity to answer a composition question.
- A second capability endpoint was rejected. The existing compatibility surface is preserved and extended.
- Deriving composition from conditional source branches was rejected, consistent with ADR-0002.

## Consequences

- The registry moves out of the documentation bundle and becomes application source. The capability gate must import it rather than parse its text.
- The capability compatibility endpoint is projected from the resolved set, so the advertised surface and the enforced surface cannot disagree.
- Guard ordering becomes a tested invariant, not a convention.
- `identity.edition-entitlements` stops being an unimplemented declaration once the resolver ships. The capability contract, pack profiles, and executive report are updated by the change that implements it, not before.
- The existing environment feature guard is superseded by the general capability guard.

## Verification

Run the capability gate, the documentation gate, and the architecture map check. A test pins guard ordering. A snapshot test pins the capability response shape against its pre-change output.
````

- [ ] **Step 2: Verify the bundle accepts it**

```bash
node scripts/check-okf-bundle.cjs docs
```

Expected: PASS. A failure naming `linked concept does not exist` means a link target is wrong; both linked paths must exist under `docs/`.

- [ ] **Step 3: Run the full documentation gate**

```bash
node scripts/check-documentation.cjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/decisions/adr-0007-runtime-composition-resolution.md
git commit -m "docs: record the runtime composition resolution decision"
```

---

### Task 3: Backend ADR-0008, build profiles and artifact exclusion

**Files:**
- Create: `docs/architecture/decisions/adr-0008-build-profiles-and-artifact-exclusion.md`

**Interfaces:**
- Consumes: the narrowing model from ADR-0007, whose first layer this record defines.
- Produces: the backend half of the exclusion decision that the frontend ADR in Task 6 mirrors.

- [ ] **Step 1: Create the record**

Write exactly:

````markdown
---
type: "Decision"
title: "Build profiles and artifact exclusion"
description: "Compile each artifact from a declared set of packs and exclude code for packs it does not contain."
tags: [architecture, decision, packs, composition]
status: stable
timestamp: "2026-09-11T00:00:00Z"
sources:
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Composition pack contract"
  - id: composition-resolution
    resource: "/architecture/decisions/adr-0007-runtime-composition-resolution.md"
    title: "Runtime composition resolution"
---
# ADR-0008: Build profiles and artifact exclusion

**Decision date:** 2026-09-11
**Decision status:** Accepted
**Scope:** Build composition and artifact contents

## Decision

A build profile is a declared set of packs compiled into one artifact. A profile is not a pack, and a pack is not an artifact.

| Profile | Packs | Tenancy | Edition resolved from |
|---|---|---|---|
| `hosted` | saas, edu | multi-tenant | the tenant |
| `enterprise` | enterprise | single-tenant per deployment | the environment, at startup |

An artifact excludes source for packs its profile does not contain. Exclusion is derived from declared composition data and is applied by build configuration. It never takes the form of an edition comparison in source.

The profile is the ceiling of the narrowing order in ADR-0007. No later layer can enable a capability whose pack was not compiled in.

## Rejected alternatives

- One artifact for every profile was rejected. Code for a pack a customer did not buy would ship to that customer.
- One artifact per pack was rejected. It cannot express a hosted deployment that serves more than one pack and resolves the edition per tenant.
- Duplicated source trees per pack were rejected. Exclusion removes code from a build; it does not create a second copy to maintain.
- Relying on runtime checks alone was rejected. A runtime check cannot remove code from an artifact a customer receives.

## Consequences

- Each profile produces a separate artifact and requires its own verification run.
- Excluding a pack must fail the build when shared source depends on excluded source. That failure is the intended signal.
- Exclusion in an artifact that is never delivered to a customer is hygiene, not a security control, and must not be described as one.
- Pack profiles stop being purely documentary once profiles exist. Those documents are updated by the change that implements profiles.

## Verification

Each profile is built, started, and checked so that its resolved capability set equals its documented pack table. Build output is scanned for symbols belonging to excluded packs; that scan is the enforcement of this decision.
````

- [ ] **Step 2: Verify the bundle**

```bash
node scripts/check-okf-bundle.cjs docs
node scripts/check-documentation.cjs
```

Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/decisions/adr-0008-build-profiles-and-artifact-exclusion.md
git commit -m "docs: record the build profile and artifact exclusion decision"
```

---

### Task 4: Backend cross-references

**Files:**
- Modify: `docs/architecture/decisions/adr-0002-orthogonal-product-axes.md`
- Modify: `docs/architecture/decisions/adr-0003-composition-packs-and-entitlements.md`
- Modify: `docs/architecture/decisions/index.md`

**Interfaces:**
- Consumes: the two records created in Tasks 2 and 3.
- Produces: a decision index a reader can navigate without knowing the history.

Do not rewrite the decisions or their narrowing blocks. Both records remain accurate accounts of what was decided at the time. They gain a pointer only.

- [ ] **Step 1: Add the pointer to ADR-0002**

Append this section to the end of `adr-0002-orthogonal-product-axes.md`:

```markdown
## Later decisions

[ADR-0007](adr-0007-runtime-composition-resolution.md) makes composition resolution a runtime behaviour and states the narrowing layers in force. [ADR-0008](adr-0008-build-profiles-and-artifact-exclusion.md) makes the build layer an explicit set of packs. The orthogonality rule in this record is unchanged.
```

- [ ] **Step 2: Add the pointer to ADR-0003**

Append this section to the end of `adr-0003-composition-packs-and-entitlements.md`:

```markdown
## Later decisions

This record required any runtime pack-selection feature to be a separate decision. That decision is [ADR-0007](adr-0007-runtime-composition-resolution.md), which supersedes the consequence that the registry does not implement runtime entitlement resolution. [ADR-0008](adr-0008-build-profiles-and-artifact-exclusion.md) adds artifact exclusion. Pack ownership rules in this record are unchanged.
```

- [ ] **Step 3: Extend the decision index**

Append two bullets to `docs/architecture/decisions/index.md`:

```markdown
* [ADR-0007: Runtime composition resolution](adr-0007-runtime-composition-resolution.md) - kernel-owned capability resolution and entitlement separation.
* [ADR-0008: Build profiles and artifact exclusion](adr-0008-build-profiles-and-artifact-exclusion.md) - pack sets per artifact and excluded source.
```

- [ ] **Step 4: Verify**

```bash
node scripts/check-okf-bundle.cjs docs
node scripts/check-documentation.cjs
```

Expected: both PASS. Relative links between sibling records must resolve.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/decisions
git commit -m "docs: link the composition decisions from the existing records"
```

---

### Task 5: Frontend ADR-0003 amendment

**Files:**
- Modify: `docs/architecture/decisions/adr-0003-shared-catalog-and-packs.md:31`

**Interfaces:**
- Consumes: nothing.
- Produces: the removal of the contradiction that otherwise blocks the frontend ADR in Task 6.

Line 31 currently reads `- Pack-specific route trees or edition folders were rejected.` Taken literally this forbids build-profile exclusion. The intent was to reject duplication, not exclusion, so the bullet is made precise.

- [ ] **Step 1: Replace the rejected-alternative bullet**

Replace that single line with:

```markdown
- Pack-specific route trees, duplicated screens, and edition folders were rejected. Removing a pack's source from a build artifact is not covered by this rejection; see ADR-0004.
```

- [ ] **Step 2: Verify**

```bash
cd alphaci-enterprise-fe
node scripts/check-okf-bundle.cjs docs
node scripts/check-documentation.cjs
```

Expected: both PASS. The link to `ADR-0004` is plain text at this point, so no link check applies until Task 6 creates the file.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/decisions/adr-0003-shared-catalog-and-packs.md
git commit -m "docs: separate rejected pack duplication from permitted build exclusion"
```

---

### Task 6: Frontend ADR-0004, build-profile exclusion

**Files:**
- Create: `docs/architecture/decisions/adr-0004-build-profile-exclusion.md`
- Modify: `docs/architecture/decisions/index.md`

**Interfaces:**
- Consumes: the amended rejection from Task 5 and backend ADR-0008, which this record mirrors.
- Produces: the frontend contract that later build work implements.

- [ ] **Step 1: Create the record**

Write exactly:

````markdown
---
type: "Decision"
title: "Build profile exclusion"
description: "Exclude non-selected pack source from frontend artifacts and depend on a published capability catalog."
tags: [architecture, decision, packs, composition]
status: stable
timestamp: "2026-09-11T00:00:00Z"
sources:
  - id: shared-catalog
    resource: "/architecture/decisions/adr-0003-shared-catalog-and-packs.md"
    title: "Shared catalog and packs"
  - id: capability-contract
    resource: "/capabilities/capability-contract.md"
    title: "Capability contract"
---
# ADR-0004: Build profile exclusion

**Decision date:** 2026-09-11
**Decision status:** Accepted
**Scope:** Frontend build composition and catalog dependency

## Decision

This frontend remains one codebase with one route tree. It produces more than one artifact. Each artifact is built for a profile, which is a declared set of packs, and excludes feature source belonging to packs outside that set.

Exclusion is derived from the capability surface registry, which already records the domains and routes each capability owns. No pack-specific route tree, duplicated screen, or edition folder is introduced, and no edition comparison enters source.

The capability catalog is consumed as a published, versioned dependency owned by the backend. A local sibling checkout is not a contract.

## Rejected alternatives

- Shipping every pack's source in one bundle was rejected. A browser bundle is delivered to the customer, so unselected pack code would be readable by customers who did not buy it.
- Duplicating the route tree per pack was rejected, consistent with ADR-0003.
- Synchronising the catalog through a sibling checkout was rejected as the contract. It cannot be verified by continuous integration.

## Consequences

- Each profile is built and verified separately.
- Route paths for excluded features may still appear in build output even when their implementation does not. Removing the paths themselves requires pruning the route tree before the build and is not adopted.
- Catalog drift becomes a reviewable dependency change instead of an unverified local step.
- Pack profiles and the capability matrix are updated by the change that implements profiles, not by this record.

## Verification

Each profile is built and its output scanned for symbols belonging to excluded packs. The catalog dependency is checked against the version the backend publishes.
````

- [ ] **Step 2: Extend the decision index**

Append one bullet to `docs/architecture/decisions/index.md`:

```markdown
* [ADR-0004: Build profile exclusion](adr-0004-build-profile-exclusion.md) - per-profile artifacts and the published catalog dependency.
```

- [ ] **Step 3: Verify**

```bash
node scripts/check-okf-bundle.cjs docs
node scripts/check-documentation.cjs
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/decisions
git commit -m "docs: record the frontend build profile exclusion decision"
```

---

### Task 7: Change records

**Files:**
- Modify: `docs/log.md` and `CHANGELOG.md` in both repositories

**Interfaces:**
- Consumes: every preceding task.
- Produces: the record the constitution requires for a contract change.

- [ ] **Step 1: Add the backend log entries**

`docs/log.md` already has a `## 2026-09-11` section. Append these bullets to it, matching the existing `* **Update**:` and `* **Creation**:` shape:

```markdown
* **Creation**: Recorded the runtime composition resolution decision (ADR-0007). Capability resolution moves into the kernel and narrows through build profile, edition manifest, deployment configuration and tenant override, with the `requires` closure applied last. Subscription entitlement is deliberately excluded from that chain: it answers whether a caller has bought access, not what the product offers, so it stays owned by Billing and runs after resolution. The composition check runs first so an unentitled caller cannot learn that an out-of-pack capability exists.
* **Creation**: Recorded the build profile and artifact exclusion decision (ADR-0008). A profile is a declared set of packs compiled into one artifact, which is what lets a hosted deployment carry SaaS and EDU and resolve the edition per tenant while an Enterprise artifact carries neither. Exclusion is derived from composition data and applied by build configuration, never by an edition comparison in source.
* **Update**: Linked ADR-0002 and ADR-0003 forward to the two new records rather than rewriting them. Both remain accurate accounts of what was decided at the time; ADR-0003 had already required any runtime pack-selection feature to be a separate decision, and ADR-0007 is that decision.
* **Update**: Moved the SaaS-to-Enterprise review out of `docs/architecture/`. It is a dated report naming local checkout paths, so it failed the bundle gate that canonical current-state documentation must pass, and it blocked every other documentation check.
* **Update**: Made the documentation bundle gate skip the `superpowers` directory, matching the frontend, so dated specs and plans stop being validated as canonical current-state documents.
```

- [ ] **Step 2: Add the backend changelog entries**

In `CHANGELOG.md` under `## [Unreleased]`, add to the existing `### Added` and `### Changed` lists:

```markdown
### Added

- Added ADR-0007, recording that capability composition resolves at runtime in the kernel, and that subscription entitlement stays a separate Billing decision applied after resolution.
- Added ADR-0008, recording build profiles as declared pack sets whose artifacts exclude source for packs they do not contain.

### Changed

- Linked ADR-0002 and ADR-0003 forward to the composition decisions instead of rewriting their original narrowing statements.
- Moved the SaaS-to-Enterprise review out of the canonical documentation bundle, and made the bundle gate skip the `superpowers` directory.
```

No product behaviour changed, so nothing belongs under a fixed or removed heading.

- [ ] **Step 3: Add the frontend entries**

In `alphaci-enterprise-fe`, read `docs/log.md` and `CHANGELOG.md` first and match whatever heading and entry shape they already use. Record this content:

```markdown
* **Creation**: Recorded the build profile exclusion decision (ADR-0004). This frontend stays one codebase with one route tree and begins producing more than one artifact, each excluding feature source for packs outside its profile. Exclusion is derived from the capability surface registry, which already records the domains and routes each capability owns, so no route tree is duplicated. The capability catalog becomes a published versioned dependency, because a sibling checkout cannot be verified by continuous integration.
* **Update**: Made ADR-0003's rejected alternative precise. It rejected pack-specific route trees and edition folders, which reads as a ban on build-time exclusion; the intent was to reject duplication, so the bullet now separates duplicated screens from removing a pack's source from an artifact.
```

- [ ] **Step 4: Verify both repositories**

```bash
node scripts/check-okf-bundle.cjs docs
node scripts/check-documentation.cjs
node scripts/check-capabilities.cjs
```

Expected: all PASS in both repositories. The capability gate must still pass unchanged, because no capability record was touched.

- [ ] **Step 5: Confirm no source changed**

```bash
git diff --stat main...HEAD -- src
```

Expected: empty output in both repositories.

- [ ] **Step 6: Commit**

```bash
git add docs/log.md CHANGELOG.md
git commit -m "docs: record the composition decision changes"
```

---

## Done when

- Three decision records exist and are reachable from both decision indexes.
- No document claims that runtime composition resolution or build profiles already exist.
- `check-okf-bundle`, `check-documentation`, and `check-capabilities` pass in both repositories.
- `git diff main...HEAD -- src` is empty in both repositories.
