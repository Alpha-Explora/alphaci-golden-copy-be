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
| `surface`             | Backend-owned API/view projection metadata, including routes, feature barrels, and optional `artifactSymbols` used by sibling profile-exclusion checks.                                                                                                                                                 |

Edition applicability is owned by `src/kernel/composition/manifests.ts`, not by individual capability records. The [generated matrix](/capabilities/capability-matrix.generated.md) is derived from the application-owned registry at `src/kernel/composition/capability-registry.ts` and those manifests. The live `/api/v1/capabilities` response is a compatibility projection of the resolved deployment set: its existing nested fields remain available, with top-level `edition` and `capabilityKeys` identifying the active composition.

The backend packages the public composition metadata as `@alphaci/capability-catalog`.
The package contains stable keys, context, descriptions, maturity, edition
applicability, dependency edges, configuration flags, and backend-owned
surface metadata. The frontend consumes the package artifact and does not read
this repository's TypeScript source.

### Package provenance and integrity

The generated package also contains `provenance.json`. It records the package
name and version, the stable source repository identifier
`github.com/Alpha-Explora/alphaci-golden-copy-be`, the authoritative source path
`src/kernel/composition/catalog.source.json`, a catalog source digest, and a
deterministic artifact digest. It contains no timestamps or checkout-specific
paths.

The catalog source digest is SHA-256 over canonical JSON: object keys are sorted
recursively while array order is preserved. The artifact digest is SHA-256 over
the JSON encoding of filename/content pairs for this ordered canonical set:
`package.json`, `catalog.json`, `index.d.ts`, `index.js`, and `manifests.json`.
Text content is normalized to LF before hashing. `provenance.json` is excluded
from that set to avoid a self-referential digest. The package generator and
`check-capability-package` implement this contract; the checker recomputes the
digest and rejects stale or tampered output.

The kernel `CapabilityGuard` enforces capabilities declared with
`@RequiresCapability(...)` at the request boundary. No capability metadata means
the guard allows the request. When metadata is present, it resolves through the
subject-scoped `CAPABILITY_RESOLVER.for(...)` path, forwarding the authenticated
session's optional `tenantId`; a missing capability is returned as a generic
`404 Not Found` with the message `Requested capability is not available`.
Handler metadata overrides class metadata. `SubscriptionGuard` is a separate
kernel guard that reads Billing through the `SUBSCRIPTION_ACCESS` port and runs
after composition, and the capability guard does
not inspect subscription state. Gated controllers declare the guards in the
order `SessionAuthGuard, CapabilityGuard, SubscriptionGuard`, so an absent
capability answers 404 before an unentitled request answers 402.

### HTTP route coverage gate

Every HTTP handler must carry an explicit capability decision: capability
metadata from @RequiresCapability(...) at class or handler scope, together
with CapabilityGuard in @UseGuards at class or handler scope. The architecture
test in tests/architecture/capability-route-coverage.spec.ts enforces both
conditions. An intentionally ungated handler belongs in that test's baseline
under its normalized controller path, with one controller reason and an
explicit handler-plus-HTTP-method entry. Adding a new handler to an existing
baseline controller still requires adding that handler to the route list;
remove entries when routes are deleted or become covered.

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

The tenant override layer has no source. The manifest source accepts the request subject and ignores it, so every tenant of one deployment resolves the same set.

### Composition configuration

| Variable | Values | Unset |
| --- | --- | --- |
| `ALPHACI_BUILD_PROFILE` | `hosted`, `enterprise` | `enterprise` |
| `ALPHACI_EDITION` | `saas`, `edu`, `enterprise` | `enterprise` |
| `ALPHACI_CLIENT` | a client ID registered in `src/packs/enterprise/clients/index.ts` | no client policy |
| `ALPHACI_CLIENT_CONFIG` | path to a client policy document | no client policy |

An invalid value stops the boot. The edition is read from the environment at startup in every profile. The boot also fails when the edition manifest names a capability outside the build profile. `npm run start:saas`, `start:edu`, `start:enterprise`, and `start:enterprise-client` set the profile, edition, and client together through `scripts/run-edition.mjs`.

### Resolution rules

`src/kernel/composition/capability-resolver.ts` applies these rules:

- A capability is enabled only when every `configurationFlags` path resolves to exactly `true`. A missing or non-boolean value narrows it out.
- A `not-implemented` record never appears in the resolved set, even when a manifest lists it.
- A capability whose `requires` key was removed is removed too, until the set stops changing. The result keeps registry order.
- A duplicate registry key, an unknown or duplicate manifest key, a manifest out of registry order, an unknown `requires` key, or a `requires` cycle is an error.

Three injection tokens carry the composition. `CAPABILITY_RESOLVER` is request-scoped. `DEPLOYMENT_CAPABILITY_RESOLVER` is a singleton for workers and services without a request subject. `CAPABILITY_MANIFEST_SOURCE` is the replaceable manifest seam. `/api/v1/capabilities` reads the deployment set.

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

## Authoring

`src/kernel/composition/catalog.source.json` is the authoring source. One record carries the capability, its pack membership, configuration flags, and its frontend surface, including any unique implementation symbols that profile checks must exclude. `capability-registry.ts`, `manifests.ts`, and the public package are generated from it and must not be edited by hand; `npm run generate:composition` rewrites the registry/manifests and `npm run check:composition-source` rejects drift.

`npm run capability:new` adds a capability in one command, deriving the registry, the manifests, the three pack rows, the generated maps, and the ledger entry. A configuration flag named by a record is code and still has to exist in `AppConfig`. See [ADR-0010](/architecture/decisions/adr-0010-single-authoring-source-for-composition.md).

## Verification

Run `npm run check:capability-package`, `npm run check:capabilities`, `npm run check:capability-ledger`, `npm run check:composition-profiles`, `npm run generate:architecture-maps -- --check`, and `npm run check:documentation`. Review any capability change against the [orthogonal axes decision](/architecture/decisions/adr-0002-orthogonal-product-axes.md) and [pack contract](/packs/pack-contract.md). The capability checks include package parity, pack catalog completeness, and ledger currency.
