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
3. **Capability status** - every registry capability in registry order, with derived status.
4. **Deployment scope** - deployment-target facts without confusing them with edition.
5. **Configuration and entitlements** - narrowing values and current implementation limits.
6. **Explicit non-support** - product areas that are not registry keys.
7. **Ownership and verification** - source owners and review commands.

## Status vocabulary

- `available`: current compatibility surface is present.
- `configuration-gated`: the surface exists but requires configured flags or providers.
- `not-implemented`: this pack includes the capability, and the backend does not provide it.
- `not-applicable`: this pack does not include the capability.

Pack status is derived from the application capability registry and pack manifests, not invented per pack:

- If the capability is absent from the pack manifest, status is `not-applicable`.
- `stable` maps to `available`.
- `limited` maps to `configuration-gated`.
- `not-implemented` maps to `not-implemented`.

## Shared catalog rule

Every pack profile lists every capability key from the application registry in registry order. Edition applicability comes from `src/kernel/composition/manifests.ts`, and the public `@alphaci/capability-catalog` package carries the key, maturity, applicability, and dependency contract to the frontend. The three tables are comparable by row. Pack-specific product areas that are not registry keys belong only in Explicit non-support.

`npm run check:capability-package` verifies the generated public package. `npm run check:capabilities` rejects a pack table that samples, reorders, omits, or restates a capability status that the registry does not support.

## Entitlement rule

Pack applicability narrows in this order:

```text
build profile -> edition manifest -> deployment configuration -> tenant override
```

The profile is the artifact ceiling. The backend validates `ALPHACI_BUILD_PROFILE` at boot and the resolver rejects a manifest outside that ceiling. Each profile is compiled in isolation. The repository declares reserved pack-only roots and symbol markers, but none are present as implementation code yet; the fail-closed compiled-output scanner proves their absence and rejects a later present path or marker.

## Update rule

Update every affected pack profile and the generated capability matrix when a shared capability contract changes. Record the change in `docs/log.md` and `CHANGELOG.md`. Use the [pack template](pack-template.md) to keep the three profiles structurally comparable.
