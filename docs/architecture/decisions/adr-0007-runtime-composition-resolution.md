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
