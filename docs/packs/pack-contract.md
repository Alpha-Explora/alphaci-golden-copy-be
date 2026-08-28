---
type: "Executable Contract"
title: "Composition pack contract"
description: "Common current-state contract for SaaS, EDU, and Enterprise pack documentation."
tags: [packs, capabilities, contracts]
status: stable
sources:
  - id: pack-decision
    resource: "/architecture/decisions/adr-0003-composition-packs-and-entitlements.md"
    title: "Composition pack decision"
  - id: capability-contract
    resource: "/capabilities/capability-contract.md"
    title: "Capability contract"
---
# Composition pack contract

Each pack profile uses the same sections, capability vocabulary, and status values. A pack is a composition declaration and documentation boundary. It does not own business logic, provider adapters, migrations, or core-table columns.

## Required profile sections

1. **Identity** - stable pack ID and display name.
2. **Current composition** - what the profile describes in this repository.
3. **Capability status** - comparable capability rows with explicit maturity.
4. **Deployment scope** - deployment-target facts without confusing them with edition.
5. **Configuration and entitlements** - narrowing values and current implementation limits.
6. **Explicit non-support** - product areas not implemented in this backend.
7. **Ownership and verification** - source owners and review commands.

## Status vocabulary

- `available`: current compatibility surface is present.
- `configuration-gated`: the surface exists but requires configured flags or providers.
- `not-implemented`: the backend does not provide the named product behavior.
- `documentation-only`: a declaration exists for comparison and does not change runtime behavior.

## Entitlement rule

Pack applicability narrows in this order:

```text
build -> edition manifest -> deployment configuration -> tenant override
```

The profile must never imply that a tenant override can enable a capability absent from the build or pack composition.

## Update rule

Update every affected pack profile and the generated capability matrix when a shared capability contract changes. Record the change in `docs/log.md` and `CHANGELOG.md`. Use the [pack template](pack-template.md) to keep the three profiles structurally comparable.
