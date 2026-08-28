---
type: "Playbook"
title: "Deployment provisioning"
description: "Operate the current Runtime provider provisioning paths for Render, Vercel, and GCP."
tags: [runbook, runtime, providers, deployment]
status: stable
sources:
  - id: runtime-module
    resource: "src/modules/runtime/runtime.module.ts"
    title: "Runtime composition"
  - id: provider-map
    resource: "/architecture/provider-map.generated.md"
    title: "Runtime provider map"
  - id: provider-source
    resource: "src/modules/runtime/infrastructure/providers"
    title: "Provider implementations"
---
# Deployment provisioning

## Current behavior

Runtime can create provider deployment targets during project setup and push initial environment values to the configured provider. Environment values are write-only from the backend perspective; the repository stores metadata rather than secret values.

## Provider strategy

| Provider | Current composition | Current outcome |
|---|---|---|
| Vercel | managed or configured connection through Runtime | CI-pushed deployment and preview support where enabled |
| Render | managed or configured connection through Runtime | image-pushed, Git-connected, or existing-service strategies according to target policy |
| GCP | GCP deployment module and Runtime registry | Cloud Run and Artifact Registry provisioning when enabled |

Provider selection, policy, credentials, and workflow fragments remain inside Runtime. Use the [provider map](/architecture/provider-map.generated.md) for the current source locations.

## Managed Render

When managed Render provisioning is enabled:

1. Runtime creates an image-backed Render service through the Render API.
2. The bootstrap image is supplied by `FLOWCI_RENDER_BOOTSTRAP_IMAGE`.
3. Runtime installs deterministic per-slot GitHub Actions secrets in the generated repository.
4. The package workflow builds and pushes the backend image to GHCR, then calls the central Render workflow.
5. The central workflow deploys the pushed image to the Render service.

Relevant configuration includes `ENV_PROVISIONING_ENABLED`, `FLOWCI_RENDER_API_KEY`, `FLOWCI_RENDER_OWNER_ID`, region and instance policy values, the managed service limit, and the bootstrap image. Keep secret values in the deployment environment.

## Managed Vercel

When managed Vercel provisioning is enabled:

1. Runtime creates a Vercel project without a provider Git repository.
2. Runtime installs per-slot GitHub Actions secrets.
3. The package workflow deploys through the central Vercel workflow.

Relevant configuration includes `FLOWCI_VERCEL_TOKEN`, `FLOWCI_VERCEL_TEAM_ID`, and the optional team slug.

## Cost and safety controls

Managed Render defaults to a web service and the configured low-cost instance type. Paid managed instance types require both explicit opt-in and allow-list membership. Use disposable targets for live smoke checks and perform cleanup before ending the test.

## Verification

Use the [deployment provisioning live smoke runbook](runbook-deployment-provisioning-live-smoke.md) only with explicit approval for external resource creation. Static provider behavior is covered by the provider acceptance tests and `npm run check:provider-encapsulation`.
