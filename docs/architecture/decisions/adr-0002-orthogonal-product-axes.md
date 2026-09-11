---
type: "Decision"
title: "Orthogonal product axes"
description: "Represent edition, tenancy, deployment target, and feature flags as independent composition values."
tags: [architecture, decision, composition]
status: stable
timestamp: "2026-08-28T00:00:00Z"
sources:
  - id: application-config
    resource: "src/kernel/config/app.config.ts"
    title: "Application configuration"
  - id: capability-endpoint
    resource: "src/modules/identity-access/capabilities/capabilities.controller.ts"
    title: "Current capability response"
---
# ADR-0002: Orthogonal product axes

**Decision date:** 2026-08-28
**Decision status:** Accepted
**Scope:** Product composition and capability advertisement

## Decision

Edition, tenancy, deployment target, and feature flag are separate values. A deployment target describes where a component runs; an edition describes a product composition; tenancy describes ownership and isolation; a feature flag controls a configured behavior. None of these values is used as a substitute for another.

The composition order is narrowing only:

```text
build -> edition manifest -> deployment configuration -> tenant override
```

A lower layer may disable a capability but may not enable one that an upper layer did not provide.

## Rejected alternatives

- Conditional source branches such as `edition === "edu"` were rejected.
- Copying the domain tree for each edition was rejected.
- Treating an on-prem deployment target as a product edition was rejected.

## Consequences

- Shared domain logic stays in its owning context.
- Composition data can describe different offerings without forking application behavior.
- The current `/api/v1/capabilities` response remains the compatibility surface; the documentation registry does not replace it.
- Pack and capability documents must distinguish applicable, configuration-gated, and not-implemented behavior.

## Verification

The documentation check scans `src/` for edition comparison branches. Capability and pack references are reviewed against the [capability contract](/capabilities/capability-contract.md) and [pack contract](/packs/pack-contract.md).

## Later decisions

[ADR-0007](adr-0007-runtime-composition-resolution.md) makes composition resolution a runtime behaviour and states the narrowing layers in force. [ADR-0008](adr-0008-build-profiles-and-artifact-exclusion.md) makes the build layer an explicit set of packs. The orthogonality rule in this record is unchanged.
