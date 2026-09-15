---
type: "Decision"
title: "Single authoring source for composition"
description: "Author one capability record and generate the registry, manifests, pack rows, and catalog from it."
tags: [architecture, decision, capabilities, composition]
status: stable
timestamp: "2026-09-15T00:00:00Z"
sources:
  - id: capability-contract
    resource: "/capabilities/capability-contract.md"
    title: "Capability contract"
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Composition pack contract"
  - id: composition-resolution
    resource: "/architecture/decisions/adr-0007-runtime-composition-resolution.md"
    title: "Runtime composition resolution"
---
# ADR-0010: Single authoring source for composition

**Decision date:** 2026-09-15
**Decision status:** Accepted
**Scope:** How a capability is declared and what is derived from it

## Decision

`src/kernel/composition/catalog.source.json` is the authoring source for composition. One record carries the capability, its pack membership, and the surfaces that present it. `capability-registry.ts` and `manifests.ts` are generated from it by `npm run generate:composition` and remain checked in, because the type system reads them: `CapabilityKey` is derived from the literal keys in the registry, so an unknown key is still a compile error anywhere in the backend.

Frontend surface data moves into that record. `apiField`, `viewFlag`, `domains`, `routes`, and `featureBarrels` describe how a capability appears, while `artifactSymbols` identifies real implementation exports that profile checks must prove absent from excluded output. The backend owns them alongside the key they describe.

`npm run capability:new` writes the record and derives the rest: the registry, the manifests, the three pack tables, the generated maps, and a ledger entry. What it cannot derive, it reports. A configuration flag named by a record is code, so the command says the flag still has to exist in `AppConfig` rather than implying the catalog created it.

The source is validated before anything is generated. A key that is not lowercase `context.name`, an unknown maturity or edition, an edition list out of canonical order, a dependency cycle, a self-reference, and a dependency absent from a pack its dependant belongs to are all authoring errors. That last rule matters most: the resolver silently drops a capability whose dependency is missing, which presents as a capability that simply does not work.

## Rejected alternatives

- Editing the registry, the manifests, the pack tables, and the frontend surface list by hand was rejected. Four places for one fact drift by construction, and the gates could only report the drift after it happened.
- Generating the registry at build time without checking it in was rejected. The literal key union is what makes an unknown capability a compile error rather than a runtime surprise.
- Leaving surface data in the frontend repository was rejected. Two owners for one contract is the sibling-checkout arrangement the package contract already replaced.
- Generating the pack profiles wholesale was rejected. Those documents carry explicit non-support and deployment notes that are not registry facts, and a generator would flatten them. The new row is derived; the surrounding prose stays written.

## Consequences

- The generated files must not be edited by hand. `npm run check:composition-source` rejects a hand edit, and `npm run check:documentation` runs it.
- Surface data is owned here and published in the catalog package. The generated provenance binds that package to this source; the frontend's vendored artifact and expected release record are downstream verification inputs.
- A capability whose dependency is absent from one of its packs now fails authoring rather than resolving to a quietly missing feature.

## Verification

Run `npm run check:composition-source`, `npm run check:capabilities`, and `npm run check:capability-ledger`. `tests/architecture/composition-source.spec.ts` covers source validation and asserts the generated files match the source through the real generator.
