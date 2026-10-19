---
type: "Playbook"
title: "Deployment provisioning"
description: "Operate the current Runtime provider provisioning paths for Render, Vercel, GCP, and on-prem hosts."
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
| On-prem host (`onprem-compose`) | Runtime registry, available when `ONPREM_RELEASES_ENABLED=true` | A target record only; the environment's host pulls signed releases by digest |

The self-hosted appliance sets none of the managed Render, Vercel, or GCP settings, so managed targets are not available there. Its usual target is an on-prem host.

Provider selection, policy, credentials, workflow fragments, and client availability remain inside Runtime provider packs. Use the [provider map](/architecture/provider-map.generated.md) for the current source locations and capability limits.

## Delivery

Every environment is delivered one way, and each deployment records which:

- **Workflow**: Render and Vercel targets. The generated pipeline deploys the first environment on push and runs `30-alphaci-promote.yml` for a promotion; CI reports status with the project CI token.
- **Host**: on-prem targets. The pipeline builds and registers the release and runs no deploy job. The release is signed by the backend itself (`ALPHACI_RELEASE_SIGNER=file`, the self-hosted appliance) or by a sign-release job in CI (hosted backend). The environment's host pulls the assignment and is the only party that may report its status.

An environment cannot mix the two: creating or attaching a target that would mix them is refused with 409, and project creation refuses it with 400 before the repository exists.

## On-prem targets

On-prem targets belong to a project environment and use `ownershipMode: byo`; the host is the customer's machine, never a managed account, and AlphaCI holds none of its credentials. Creating one makes no provider or GitHub call. Its label is `providerProjectName`, `projectName`, or the slot.

At project creation, give a target an `environmentSlug` to limit it to one environment. It replaces that environment's shared target for the same slot. For hosted test and UAT with production on a host:

```json
{
  "targets": [
    { "slot": "backend", "provider": "render", "ownershipMode": "flowci_managed" },
    { "slot": "frontend", "provider": "vercel", "ownershipMode": "flowci_managed" },
    { "slot": "backend", "provider": "onprem-compose", "ownershipMode": "byo", "environmentSlug": "main" },
    { "slot": "frontend", "provider": "onprem-compose", "ownershipMode": "byo", "environmentSlug": "main" }
  ]
}
```

The package workflow builds an image for every slot any environment's container target needs, so the production host can pull a frontend that test deploys to Vercel from source.

A two-repository project (`repoShape: multi-repo`) accepts the same environments list, each with an optional `hostAssignment`, and per-environment backend and frontend targets, including `onprem-compose`. Each repository gets the environment pipeline for its own slot.

Environments run on enrolled machines. Enroll a machine in **Hosts**, then assign environments in **Hosting**; with one connected machine, non-production environments are assigned automatically. See the [on-prem host setup runbook](runbook-onprem-host-setup.md). A legacy single-environment host registered with `POST /projects/:projectId/environments/:environmentId/hosts` keeps working until it is replaced.

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

## Roll back a Render or Vercel deployment

A deployment target's earlier deploy can be put back live from AlphaCI: `POST /projects/:projectId/deployment-targets/:targetId/rollback` with `{ "deployId": "...", "reason": "..." }`. Only an account whose application role can manage hosting (Admin or Developer) can do it. The reason (3 to 500 characters) goes into the audit trail with the user.

- Only a recent deploy that went live and is not live now can be chosen. On Vercel, only a production deployment.
- **Render** redeploys the old build as a new rollback deploy. The next pipeline deploy replaces it as usual.
- **Vercel** uses Instant Rollback, which holds new production deploys off the domains. AlphaCI records the hold on the target. End it with `POST /projects/:projectId/deployment-targets/:targetId/rollback/resume`; the newest deploy goes live again.

Other providers refuse the request. On-prem hosts do not use this route; a host restores the previous release itself when a new one fails its health check.

## Cost and safety controls

Managed Render defaults to a web service and the configured low-cost instance type. Paid managed instance types require both explicit opt-in and allow-list membership. Use disposable targets for live smoke checks and perform cleanup before ending the test.

## Verification

Use the [deployment provisioning live smoke runbook](runbook-deployment-provisioning-live-smoke.md) only with explicit approval for external resource creation. Static provider behavior is covered by the provider acceptance tests and `npm run check:provider-encapsulation`.
