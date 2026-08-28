---
type: "Provider Map"
title: "Runtime provider map"
description: "Generated inventory of the provider plugins currently composed by Runtime."
tags: [architecture, providers, runtime, map]
status: stable
sources:
  - id: "runtime-source"
    resource: "src/modules/runtime"
    title: "Runtime context source tree"
  - id: "provider-composition"
    resource: "src/modules/runtime/runtime.module.ts"
    title: "Runtime composition root"
---

# Runtime provider map

Providers are Runtime-owned plugins. The generic registries expose provider-neutral contracts to application code; provider clients, policies, workflow fragments, CI secret installers, and cloud adapters stay under `src/modules/runtime/infrastructure/providers/`.

## Current providers

| Provider id | Label | Responsibility | Supported slot | Availability |
|---|---|---|---|---|
| `gcp` | Google Cloud Platform | GCP deployment provider and Cloud Run/Artifact Registry provisioning | provider-defined deployment slots | configuration-gated by GCP deployment settings |
| `render` | Render | Render deployment targets, environment variables, policy, and CI secret installation | backend | configuration-gated by environment provisioning settings |
| `vercel` | Vercel | Vercel deployment targets, environment variables, preview lane, policy, and CI secret installation | frontend | configuration-gated by environment provisioning settings |

## Composition rules

- Provider identifiers are runtime data and are registered through Runtime composition.
- Runtime consumers receive provider-neutral catalog data, focused ports, or contracts; they do not receive provider implementation methods from another context.
- A provider may have configuration-gated live behavior. The catalog reports enabled state and selected capabilities from the registered provider.
- The current implementation still has compatibility composition in the legacy provider module and provider-specific policy classes. This map records that fact rather than claiming provider addition is code-free.

See the [provider and port decision](/architecture/decisions/adr-0004-provider-and-port-boundaries.md) and the [deployment provisioning runbook](/runbooks/runbook-deployment-provisioning.md).
