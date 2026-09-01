---
type: "Decision"
title: "Provider and port boundaries"
description: "Keep deployment providers inside Runtime and introduce focused ports only for real dependency-inversion boundaries."
tags: [architecture, decision, providers, ports]
status: stable
timestamp: "2026-08-28T00:00:00Z"
sources:
  - id: provider-registry
    resource: "src/modules/runtime/core/deployment-provider.registry.ts"
    title: "Runtime provider registry"
  - id: provider-composition
    resource: "src/modules/runtime/runtime.module.ts"
    title: "Runtime provider composition"
  - id: kernel-ports
    resource: "src/kernel/ports"
    title: "Focused dependency-inversion ports"
---
# ADR-0004: Provider and port boundaries

**Decision date:** 2026-08-28
**Decision status:** Accepted
**Scope:** Runtime provider integrations and cross-context dependencies

## Decision

Deployment providers are plugins inside Runtime. Each provider contributes a validated pack containing its descriptor and any applicable provider client, policy, workflow fragment, CI secret installer, or cloud adapter. Runtime composes the packs and exposes only provider-neutral contracts to application code.

A port is introduced only when there is a real inversion, optional integration, testing seam, policy boundary, or transport boundary. One implementation remains a concrete class; a second consumer or real replacement justifies extracting a shared interface. Ports must expose serialisable inputs and outputs and must not require consumers to import provider implementations.

The current provider IDs are `gcp`, `render`, and `vercel`. Provider identifiers are runtime data. The current compatibility provider composition still contains one explicit pack binding per provider; the generic registries protect consumer boundaries without claiming that provider addition is code-free.

## Rejected alternatives

- A provider-specific top-level bounded context was rejected.
- Vendor switches in non-Runtime contexts were rejected.
- Blanket interfaces for every class were rejected.
- Passing provider SDK clients across context boundaries was rejected.

## Consequences

- Runtime owns provider-specific behavior and credentials.
- Other contexts consume catalog data, focused ports, or provider-neutral contracts.
- Provider-specific compatibility fields may remain at current persistence/API boundaries until their contract is intentionally changed.
- Provider acceptance tests verify registry behavior and the shared adapter contract.

## Verification

Run `npm run check:provider-encapsulation`, `npm test -- --ci --runInBand tests/architecture/provider-plugin.acceptance.spec.ts`, and review the [provider map](/architecture/provider-map.generated.md).
