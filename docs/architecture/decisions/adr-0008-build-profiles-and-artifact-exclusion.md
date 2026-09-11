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
