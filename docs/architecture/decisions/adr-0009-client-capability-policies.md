---
type: "Decision"
title: "Client capability policies"
description: "Narrow an edition manifest per client with a deny-only policy resolved through one replaceable source."
tags: [architecture, decision, packs, composition]
status: stable
timestamp: "2026-09-15T00:00:00Z"
sources:
  - id: composition-resolution
    resource: "/architecture/decisions/adr-0007-runtime-composition-resolution.md"
    title: "Runtime composition resolution"
  - id: build-profiles
    resource: "/architecture/decisions/adr-0008-build-profiles-and-artifact-exclusion.md"
    title: "Build profiles and artifact exclusion"
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Composition pack contract"
---
# ADR-0009: Client capability policies

**Decision date:** 2026-09-15
**Decision status:** Accepted
**Scope:** Per-client composition within an edition

## Decision

A client is not an edition. A client is a deny-only policy that narrows one edition manifest for one deployment.

The narrowing order gains a layer:

```text
build profile -> edition manifest -> client policy -> deployment configuration -> tenant override
```

A policy declares `clientId`, `displayName`, `edition`, and `disabledCapabilities`. It can remove a capability and it can do nothing else. An Enterprise manifest is therefore the union of what any Enterprise client may run, and each client's policy removes the remainder.

Two sources satisfy one port. The real Enterprise implementation lives in
`src/packs/enterprise` and is exposed through a profile-keyed pack contract.
Both hosted profiles have no Enterprise pack source in their artifacts and the
loader returns no pack without importing it. A deployment-supplied policy is a
JSON document named by `ALPHACI_CLIENT_CONFIG`, which lets a customer-hosted
installation carry its own composition without a release. A store-backed
source can replace either without changing the resolver, the guard, or a
controller.

Selection is explicit and fails closed. `ALPHACI_CLIENT` names the client. An unknown client, an unreadable or malformed document, an unknown document field, an unknown capability key, a key the edition does not contain, or a policy written for a different edition each stop the boot instead of resolving to an unnarrowed deployment. When both variables are set, the mounted document wins and must name the same client.

Presentation is out of scope. Branding, navigation labels, and theme are not capabilities and are not carried by this policy.

## Rejected alternatives

- Adding each client to the edition union was rejected. It turns a three-value type into a customer list, and every new customer becomes a code change and a release.
- Letting a policy enable a capability was rejected. The build profile would stop being a ceiling, and the compiled-artifact scan would no longer describe what a deployment can do.
- A build profile per client as the default was rejected. It costs an artifact, a build target, and a conformance run for every customer. It stays available for a client whose contract requires the code to be absent rather than unreachable.
- Carrying client identity through module source was rejected. Capability keys remain the vocabulary; customer identity remains configuration.

## Consequences

- A capability that one client must not reach still ships inside the shared Enterprise artifact. Where physical absence is required, the answer is a client build profile, not a policy.
- A policy is deployment-scoped. Background services read it through the deployment resolver, and per-tenant policy in a hosted profile requires the subject-scoped source, which remains an unimplemented seam.
- An on-prem operator controls the mounted document, so a policy is a composition input rather than a licence. Licence enforcement stays a separate authorization layer, as subscription entitlement already is.
- Declaring a client in this repository records a customer name in source. A deployment-supplied document keeps that name outside the product.

## Verification

Run `npm run check:capabilities` and `npm run check:composition-profiles`. Focused coverage lives in `src/packs/enterprise/client-policy.spec.ts`, `src/packs/enterprise/client-policy-pack.spec.ts`, `src/kernel/composition/client-policy-pack-loader.spec.ts`, and the capability controller projection tests. They exercise document validation, source selection, fail-closed boots, profile loading, and manifest narrowing on both the deployment and subject paths.
