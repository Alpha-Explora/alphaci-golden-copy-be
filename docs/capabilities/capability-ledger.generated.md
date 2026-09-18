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
| 2026-09-18 | maturity-changed | `identity.self-serve-auth` | Enabled the configurable SaaS self-serve auth slice while keeping billing checkout deferred and EDU or Enterprise provider-only. | docs/superpowers/plans/2026-09-18-saas-self-serve-auth-backend.md |
| 2026-09-18 | added | `identity.self-serve-auth` | Added the self-serve auth capability so SaaS composes email, Google, and public signup while enterprise and edu keep provider-only sign-in. | CHANGELOG.md |
| 2026-09-15 | added | `platform.public-site` | Declared the SaaS-only public marketing site; EDU and Enterprise deployments go straight to login. | CHANGELOG.md |
| 2026-09-15 | added | `runtime.client-composition` | Enterprise client composition is now a real pack-owned deny-only surface with backend-owned frontend surface metadata | adr-0009-client-capability-policies.md |
| 2026-09-15 | baseline | catalog | Baseline of the kernel-owned capability catalog: 29 keys across six contexts, with SaaS, EDU, and Enterprise manifests, dependency edges, and configuration-flag bindings as they stand after the catalog moved into src/kernel/composition. | adr-0007-runtime-composition-resolution.md |

## Current catalog

- Capabilities: **32**
- Composition hash: `sha256:228a02ee961108bc2c51daeb5d91e49a5843eede9f1507a835bcef4514499b3d`

The hash covers every capability key, maturity, dependency edge, configuration flag, and edition membership in registry order. `npm run check:capability-ledger` recomputes it and rejects a catalog that moved without a ledger entry. `npm run ledger:record` appends an entry with the correct hash.
