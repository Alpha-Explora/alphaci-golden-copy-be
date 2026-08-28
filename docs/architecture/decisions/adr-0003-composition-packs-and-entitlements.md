---
type: "Decision"
title: "Composition packs and entitlements"
description: "Use comparable pack declarations and narrowing entitlement precedence without copying domain ownership."
tags: [architecture, decision, packs, capabilities]
status: stable
timestamp: "2026-08-28T00:00:00Z"
sources:
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Current pack contract"
  - id: capability-registry
    resource: "/capabilities/registry.ts"
    title: "Documentation capability registry"
---
# ADR-0003: Composition packs and entitlements

**Decision date:** 2026-08-28
**Decision status:** Accepted
**Scope:** SaaS, EDU, and Enterprise product composition references

## Decision

SaaS, EDU, and Enterprise are composition packs. A pack selects and documents capabilities; it does not own domain logic, context persistence, provider adapters, or core-table columns.

Entitlement evaluation is narrowing and follows this precedence:

```text
build -> edition manifest -> deployment configuration -> tenant override
```

The pack contract uses the same headings and capability vocabulary for every pack so differences are explicit and reviewable. The registry under `docs/capabilities/` is a documentation source and does not implement runtime entitlement resolution.

## Rejected alternatives

- A separate domain implementation for each pack was rejected.
- Pack-specific database schemas for shared product entities were rejected.
- A tenant override that enables an unavailable or unlicensed capability was rejected.
- Treating marketing content as backend domain behavior was rejected.

## Consequences

- Pack documents can be compared without inferring missing behavior.
- Unsupported product areas are recorded as `not-implemented` rather than implied.
- Context owners remain responsible for business behavior and persistence.
- Any runtime pack-selection feature requires a separate behavior change and contract review.

## Verification

Review pack files against the [pack contract](/packs/pack-contract.md), the generated [capability matrix](/capabilities/capability-matrix.generated.md), and the [constitution](/constitution.md). The documentation check rejects edition branches in source code.
