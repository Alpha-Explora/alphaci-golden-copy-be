---
type: "Capability Map"
title: "Capability ledger"
description: "Generated history of capability lifecycle changes recorded against the application capability catalog."
tags: [capabilities, map, packs]
status: stable
sources:
  - id: "capability-ledger"
    resource: "docs/capabilities/ledger.json"
    title: "Capability ledger entries"
  - id: "capability-registry"
    resource: "src/kernel/composition/capability-registry.ts"
    title: "Application capability registry"
  - id: "ledger-gate"
    resource: "scripts/check-capability-ledger.cjs"
    title: "Capability ledger gate"
---

# Capability ledger

This ledger records how the capability catalog reached its current shape. The [capability matrix](capability-matrix.generated.md) describes the catalog as it stands; this file describes what changed, when, and under which record.

Entries are newest first. A ledger entry is required whenever a capability key, maturity, dependency edge, configuration flag, or edition membership changes. Wording and description edits do not require one.

| Date | Change | Keys | Summary | Reference |
|---|---|---|---|---|
| 2026-09-15 | added | `runtime.client-composition` | Enterprise client composition is now a real pack-owned deny-only surface with backend-owned frontend surface metadata | adr-0009-client-capability-policies.md |
| 2026-09-15 | baseline | catalog | Baseline of the kernel-owned capability catalog: 29 keys across six contexts, with SaaS, EDU, and Enterprise manifests, dependency edges, and configuration-flag bindings as they stand after the catalog moved into src/kernel/composition. | adr-0007-runtime-composition-resolution.md |

## Current catalog

- Capabilities: **30**
- Composition hash: `sha256:0276b9c0b5166b03dd0cfb371df828e2827f42e973a142e3457d34eb1ac8431d`

The hash covers every capability key, maturity, dependency edge, configuration flag, and edition membership in registry order. `npm run check:capability-ledger` recomputes it and rejects a catalog that moved without a ledger entry. `npm run ledger:record` appends an entry with the correct hash.
