---
type: "Executable Contract"
title: "Capability contract"
description: "Current vocabulary for describing capability ownership, maturity, configuration, and pack applicability."
tags: [capabilities, contracts, composition]
status: stable
sources:
  - id: compatibility-endpoint
    resource: "src/modules/identity-access/capabilities/capabilities.controller.ts"
    title: "Current capability compatibility endpoint"
  - id: configuration
    resource: "src/kernel/config/app.config.ts"
    title: "Application configuration"
  - id: capability-gate
    resource: "scripts/check-capabilities.cjs"
    title: "Capability registry gate"
---
# Capability contract

A capability is a named product behavior owned by one bounded context. Capability keys are documentation identifiers; they do not add endpoints, flags, or persistence on their own.

## Record shape

Each registry record contains:

| Field | Meaning |
|---|---|
| `key` | Stable lowercase capability identifier, scoped by owning context. |
| `context` | Bounded context that owns the behavior. |
| `description` | Current behavior in one sentence. |
| `maturity` | `stable`, `limited`, or `not-implemented`. |
| `editions` | Pack documents for which the capability is applicable as a composition reference. |
| `configuration` | Current source of enablement or gating. |
| `configurationFlags` | Boolean `AppConfig` leaves, as `group.flag` paths, that gate the capability. Checked against `src/kernel/config/app.config.ts` in both directions. |
| `requires` | Capability keys this capability depends on. Edges must resolve, stay acyclic, and never be applicable in fewer editions than their dependents. |

The [generated matrix](/capabilities/capability-matrix.generated.md) is derived from `registry.ts`. The registry is intentionally separate from the live `/api/v1/capabilities` response, which retains its compatibility-shaped response and current configuration behavior.

`configuration` stays human-readable prose. `configurationFlags` is the machine-checked form of the same claim: without it, a flag could be renamed in `app.config.ts` while the registry and the generated matrix both stayed green. Every boolean `AppConfig` leaf must be owned by exactly one record or listed in the `NON_CAPABILITY_FLAGS` exemption set in `scripts/check-capabilities.cjs`, which makes "this toggle is not a product capability" an explicit decision rather than an omission.

## Maturity

- `stable`: the current repository exposes the behavior as a supported compatibility surface.
- `limited`: the surface exists but is configuration-gated, snapshot/local, provider-dependent, or otherwise deliberately limited.
- `not-implemented`: the product area is explicitly absent from this backend.

`not-implemented` is a useful negative declaration. It must not be interpreted as a disabled entitlement that runtime already resolves.

## Narrowing composition

Applicable capability composition is evaluated in this order:

```text
build -> edition manifest -> deployment configuration -> tenant override
```

Each layer can narrow the set. No layer can enable a capability that is not present in the preceding layer.

## Naming and ownership

- Use lowercase dot-separated keys such as `runtime.env-provisioning`.
- Put provider-neutral capability keys in the owning context, not under a provider name.
- Record provider-specific availability in the provider map and pack notes.
- Update the registry and generated matrix with the code/configuration change that changes the behavior.

## Verification

Run `npm run check:capabilities`, `npm run generate:architecture-maps -- --check`, and `npm run check:documentation`. Review any capability change against the [orthogonal axes decision](/architecture/decisions/adr-0002-orthogonal-product-axes.md) and [pack contract](/packs/pack-contract.md).
