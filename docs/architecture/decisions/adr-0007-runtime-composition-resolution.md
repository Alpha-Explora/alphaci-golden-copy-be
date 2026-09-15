---
type: 'Decision'
title: 'Runtime composition resolution'
description: 'Resolve capability composition at runtime from a kernel-owned registry instead of documentation alone.'
tags: [architecture, decision, composition, capabilities]
status: stable
timestamp: '2026-09-11T00:00:00Z'
sources:
  - id: capability-contract
    resource: '/capabilities/capability-contract.md'
    title: 'Capability contract'
  - id: pack-contract
    resource: '/packs/pack-contract.md'
    title: 'Composition pack contract'
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

Subscription entitlement is **not** a narrowing layer. It is a per-request
authorization decision that stays owned by Billing and is applied after
resolution by `SubscriptionGuard`. `CapabilityGuard` enforces
`@RequiresCapability(...)` metadata through the subject-scoped resolver path; a
capability absent from the resolved set is reported with a generic not-found
response, while a capability present but unentitled reaches Billing's existing
`402 Payment Required` response.
The composition check runs before the entitlement check so an unentitled caller
cannot learn that an out-of-pack capability exists.

Resolution reads composition data only. It contains no edition comparison.

HTTP guards and controllers use the request-scoped resolver. Background
consumers that have no request subject use a separate deployment-scoped resolver
binding, which prevents Nest scope propagation from turning boot-time workers
into request-scoped providers. It resolves the same deployment manifest and
configuration; tenant narrowing remains available only through the subject path.

## Rejected alternatives

- Folding subscription entitlement into capability narrowing was rejected. It conflates what the product offers with what a caller has bought, and it would move billing policy into the kernel.
- Placing the resolver in `identity-access` was rejected. Composition is not identity behaviour, and other contexts would then depend on identity to answer a composition question.
- A second capability endpoint was rejected. The existing compatibility surface is preserved and extended.
- Deriving composition from conditional source branches was rejected, consistent with ADR-0002.

## Consequences

- The registry moves out of the documentation bundle and becomes application source. The capability gate must import it rather than parse its text.
- The capability compatibility endpoint is projected from the resolved set, so the advertised surface and the enforced surface cannot disagree.
- Guard ordering becomes a tested invariant, not a convention.
- The general capability guard supersedes the runtime-specific environment feature guard for declared request capabilities. Singleton application services use the deployment-scoped resolver so request scope does not leak into workers; tenant-specific application behavior remains a future subject-propagation concern.

## Verification

Run the capability gate, the documentation gate, and the architecture map check. Focused guard tests pin metadata behavior, subject forwarding, generic not-found handling, and guard ordering. A snapshot test pins the capability response shape against its pre-change output.
