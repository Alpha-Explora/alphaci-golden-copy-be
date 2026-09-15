---
type: 'Executable Contract'
title: 'Capability contract'
description: 'Current vocabulary for describing capability ownership, maturity, configuration, and pack applicability.'
tags: [capabilities, contracts, composition]
status: stable
sources:
  - id: compatibility-endpoint
    resource: 'src/modules/identity-access/capabilities/capabilities.controller.ts'
    title: 'Current capability compatibility endpoint'
  - id: configuration
    resource: 'src/kernel/config/app.config.types.ts'
    title: 'Application configuration'
  - id: capability-gate
    resource: 'scripts/check-capabilities.cjs'
    title: 'Capability registry gate'
---

# Capability contract

A capability is a named product behavior owned by one bounded context. Capability keys are stable application identifiers; the application-owned registry and manifests describe the runtime composition, but do not add endpoints, flags, or persistence on their own.

## Record shape

Each registry record contains:

| Field                | Meaning                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                | Stable lowercase capability identifier, scoped by owning context.                                                                                                                                                                                                                                     |
| `context`            | Bounded context that owns the behavior.                                                                                                                                                                                                                                                               |
| `description`        | Current behavior in one sentence.                                                                                                                                                                                                                                                                     |
| `maturity`           | `stable`, `limited`, or `not-implemented`.                                                                                                                                                                                                                                                            |
| `configuration`      | Current source of enablement or gating.                                                                                                                                                                                                                                                               |
| `configurationFlags` | Boolean `AppConfig` leaves, as `group.flag` paths, that gate the base capability. Checked against `src/kernel/config/app.config.types.ts` in both directions. Optional adapter or provider-mode toggles are explicit `NON_CAPABILITY_FLAGS`; this list is empty when `maturity` is `not-implemented`. |
| `requires`           | Capability keys this capability depends on. Edges must resolve and stay acyclic.                                                                                                                                                                                                                      |

Edition applicability is owned by `src/kernel/composition/manifests.ts`, not by individual capability records. The [generated matrix](/capabilities/capability-matrix.generated.md) is derived from the application-owned registry at `src/kernel/composition/capability-registry.ts` and those manifests. The live `/api/v1/capabilities` response is a compatibility projection of the resolved deployment set: its existing nested fields remain available, with top-level `edition` and `capabilityKeys` identifying the active composition.

The backend packages the public composition metadata as `@alphaci/capability-catalog`.
The package contains stable keys, maturity, edition applicability, and
dependency edges; backend-only context, configuration, and enablement details
remain in the kernel registry. The frontend consumes the package artifact and
does not read this repository's TypeScript source.

The kernel `CapabilityGuard` enforces capabilities declared with
`@RequiresCapability(...)` at the request boundary. No capability metadata means
the guard allows the request. When metadata is present, it resolves through the
subject-scoped `CAPABILITY_RESOLVER.for(...)` path, forwarding the authenticated
session's optional `tenantId`; a missing capability is returned as a generic
`404 Not Found`. `SubscriptionGuard` remains a separate Billing-owned check
that runs after composition, and the capability guard does not inspect
subscription state.

The request-scoped resolver is used by HTTP controllers and guards. Background
consumers without an HTTP subject use the deployment-scoped resolver token, so
boot-time workers such as the platform outbox relay do not inherit request
scope. That path resolves the deployment composition only; tenant narrowing
remains an explicit subject-scoped request concern.

`configuration` stays human-readable prose. `configurationFlags` is the machine-checked form of the base enablement claim: without it, a flag could be renamed in `app.config.types.ts` while the registry and the generated matrix both stayed green. Every boolean `AppConfig` leaf must be owned by exactly one implemented record or listed in the `NON_CAPABILITY_FLAGS` exemption set in `scripts/check-capabilities.cjs`, which makes "this toggle is not a product capability" an explicit decision rather than an omission. Optional live/provider-mode toggles narrow a mode or adapter, not the base capability. Records with `maturity: not-implemented` use an empty `configurationFlags` array.

## Maturity

- `stable`: the current repository exposes the behavior as a supported compatibility surface.
- `limited`: the surface exists but is configuration-gated, snapshot/local, provider-dependent, or otherwise deliberately limited.
- `not-implemented`: the product area is explicitly absent from this backend.

`not-implemented` is a useful negative declaration. It must not be interpreted as a disabled entitlement that runtime already resolves. A `not-implemented` record must not claim `AppConfig` flags; flags are added when the behavior exists.

Pack profiles project registry records with a fourth status, `not-applicable`, when the pack manifest does not contain the capability. That pack status is not a maturity value.

## Narrowing composition

Applicable capability composition is evaluated in this order:

```text
build profile -> edition manifest -> client policy -> deployment configuration -> tenant override
```

Each layer can narrow the set. No layer can enable a capability that is not present in the preceding layer.

A client policy is a deny-only declaration for one client, selected by `ALPHACI_CLIENT` or supplied as a document at `ALPHACI_CLIENT_CONFIG`. It removes capability keys from the edition manifest and cannot introduce one. See [ADR-0009](/architecture/decisions/adr-0009-client-capability-policies.md).

## Naming and ownership

- Use lowercase dot-separated keys such as `runtime.env-provisioning`.
- Put provider-neutral capability keys in the owning context, not under a provider name.
- Record provider-specific availability in the provider map and pack notes.
- Update the application registry, applicable manifests, and generated matrix with the code/configuration change that changes the behavior.

A capability change that alters keys, maturity, or edition applicability must update every pack profile in the same change. Pack tables are a comparable projection of this registry; they are not a second catalog.

## Ledger

The generated matrix describes the catalog as it stands. The [capability ledger](capability-ledger.generated.md) records how it got there, with one entry per lifecycle change: `added`, `removed`, `renamed`, `maturity-changed`, or `membership-changed`.

Entries live in `docs/capabilities/ledger.json` and are append-only. Each entry carries the composition hash of the catalog it describes, covering every key, maturity, dependency edge, configuration flag, and edition membership in registry order. `npm run check:capability-ledger` recomputes that hash and fails when the catalog moved without an entry, so the ledger cannot quietly fall behind the registry. Description and wording edits do not change the hash and do not require an entry.

Use `npm run ledger:record` to append an entry; it computes the hash and refreshes the generated ledger. The summary and the reference are written by hand, because a record derived from history can say what changed but not why.

## Verification

Run `npm run check:capability-package`, `npm run check:capabilities`, `npm run check:capability-ledger`, `npm run check:composition-profiles`, `npm run generate:architecture-maps -- --check`, and `npm run check:documentation`. Review any capability change against the [orthogonal axes decision](/architecture/decisions/adr-0002-orthogonal-product-axes.md) and [pack contract](/packs/pack-contract.md). The capability checks include package parity, pack catalog completeness, and ledger currency.
