---
type: "Decision"
title: "Configurable deployment targets"
description: "Keep managed providers as the default and add customer-hosted Compose and Kubernetes targets as configurable options for both the platform and customer projects."
tags: [architecture, decision, deployment, on-premises, runtime]
status: draft
timestamp: "2026-09-25T00:00:00Z"
sources:
  - id: provider-boundaries
    resource: "/architecture/decisions/adr-0004-provider-and-port-boundaries.md"
    title: "Provider and port boundaries"
  - id: stack-axis
    resource: "/architecture/decisions/adr-0006-stack-as-a-declared-axis.md"
    title: "Stack as a declared axis"
  - id: provider-map
    resource: "/architecture/provider-map.generated.md"
    title: "Current Runtime provider map"
---
# ADR-0012: Configurable deployment targets

**Decision date:** 2026-09-25
**Decision status:** Proposed
**Scope:** Where the AlphaCI platform runs, and where the projects it manages deploy

## Context

Two different questions are both called "deployment":

1. **Platform hosting**: where AlphaCI itself (API, frontend, PostgreSQL, outbox relay) runs. Today it is managed hosting: the API and outbox cron on Render, the frontend on Vercel, the database on Supabase.
2. **Project deployment target**: where a customer project that AlphaCI generates pipelines for is deployed. Today every deployment target names a provider (`vercel`, `render`, or `gcp`), and the pipeline generator looks up that provider's workflow fragment. React projects default to Vercel; backend stacks, including .NET, default to Render through a container image.

Customers now need both to run inside their own network, first on a Windows host through WSL2, later on Linux and Kubernetes. The existing managed paths must keep working unchanged.

## Decision

Deployment is configuration. Each question gets its own setting, and neither is derived from edition, build profile, client policy, or stack.

**Project deployment targets** stay provider-per-target, as ADR-0004 defines. Two Runtime provider packs are added beside the existing three:

| Provider id | Runs on | Delivery |
|---|---|---|
| `vercel`, `render`, `gcp` | Managed cloud (unchanged defaults) | Provider CLI, deploy hook, or Cloud Run |
| `onprem-compose` | One customer host: Windows + WSL2 Ubuntu, or Linux, running Docker Engine + Compose | Host agent pulls a signed release manifest and runs images by digest |
| `onprem-k8s` | Customer Kubernetes (K3s for the lab) | Argo CD pulls a Helm chart and a digest values file |

A project defines ordered environments with stable IDs, slugs, display names,
source branches, and roles; exactly one has the production role. Multiple
environments may use one source branch. The provider is chosen for each
`(project, environment ID, slot)` target. At most one configured provider owns
that target, regardless of its health status; a missing or failed target cannot
fall back to another provider. Secrets and deployment history are scoped to the
environment ID, not inferred from its branch. Quality gates stay shared, while
packaging and deployment follow the selected provider.

The first customer configuration is:

| Environment | Source branch | Role | React frontend | .NET backend |
|---|---|---|---|---|
| `dev` | `dev` | Test | Vercel preview | Render test service |
| `uat` | `uat` | UAT | Vercel preview | Render UAT service |
| `main` | `main` | Production | `onprem-compose` | `onprem-compose` |

The table is an editable template for new projects. Existing projects keep
their effective branches, targets, and behavior until explicitly changed. A
push to the first project environment's source branch may auto-deploy there.
Pushes to later environments' branches can run quality checks but cannot deploy
or replace the pinned release. Deployment promotion is an explicit action that
carries that release to the next ordered environment; branch-promotion pull
requests are optional and separate.
Render and customer-hosted Compose use the same GHCR image digest across
environments. Vercel is an explicit exception: each target builds from the
same pinned commit and records its own immutable deployment ID; it does not
promise identical build bytes across arbitrary Vercel environments. Today,
`dev` is not hosted and managed providers assume `main` is hosted by them, so
branch routing and provider provisioning must change before this example is
available.

The first customer-hosted implementation is `onprem-compose` for customer React and .NET projects, on a Windows host running WSL2, pulling from GHCR over an outbound connection. `onprem-k8s` follows for clients that already run Kubernetes.

**Platform hosting** is a deployment preset, like the existing `deploy/env` files: `managed` (current), `self-managed-compose`, and later `self-managed-k8s`. It uses the same artifacts and delivery rules as project targets.

Every customer-hosted option follows the same contract:

- CI builds and scans immutable OCI images, publishes them to GHCR by digest, and signs a release manifest naming the digests and any applicable migration version.
- The customer side pulls. CI and the AlphaCI control plane never hold SSH keys, kubeconfig, or host credentials, and no self-hosted runner holds production access.
- Status flows outward from the customer side (polling or an allowed outbound call); no design depends on inbound callbacks.
- Secrets are created on the host or cluster and referenced by name. They never go into images, Helm charts, registries, or manifests.
- Existing managed-provider reusable workflows remain available and gain
  backward-compatible environment and pinned-release inputs where required;
  customer-hosted delivery is added beside them.

## Rejected alternatives

- Choosing the target from the edition or client. Edition decides features; hosting is independent.
- SSH or WinRM push deploys from GitHub Actions into a customer host.
- A persistent self-hosted runner inside the customer network holding production credentials.
- Kubernetes as the only customer-hosted path. Most first customers have one Windows host and no cluster.
- K3s inside WSL2 as a supported runtime. K3s supports Linux hosts; WSL2 is for experiments only.
- Storing secrets in the Helm chart or registry. Anyone who can pull the chart could read them.

## Consequences

- React needs a container image (static build served by nginx or Caddy) for customer-hosted targets; Vercel builds it today.
- .NET customer-hosted targets are limited to SDK-style .NET in Linux containers; .NET Framework is out of scope.
- Self-managed platform hosting replaces the Supabase database with PostgreSQL, but the API still calls Supabase Auth. An authentication adapter (OIDC first) is required before the platform runs without Supabase.
- Each customer-hosted provider needs a host-side component: a small agent for Compose, Argo CD for Kubernetes.

## Verification

A customer-hosted provider is available only when its provider pack is registered, the [provider map](/architecture/provider-map.generated.md) lists it, and a deployment through it has passed install, upgrade, rollback, and host-restart checks.
