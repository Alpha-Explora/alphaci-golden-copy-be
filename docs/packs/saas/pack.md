---
type: "Composition Pack"
title: "SaaS pack"
description: "Current SaaS composition reference using the common pack contract."
tags: [packs, saas, composition]
status: stable
sources:
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Common pack contract"
  - id: capability-matrix
    resource: "/capabilities/capability-matrix.generated.md"
    title: "Current capability matrix"
---
# SaaS pack

## Identity

- Pack ID: `saas`
- Display name: `SaaS`

## Current composition

- Documentation status: `documentation-only`
- Runtime selection behavior: No pack-selection resolver is implemented in this backend.
- Current backend applicability: The same six-context backend exposes configuration-gated compatibility capabilities for a hosted deployment.

## Capability status

| Capability key | Status | Evidence or limit |
|---|---|---|
| `identity.workspaces` | `available` | Identity-access workspace capability. |
| `platform.audit-events` | `available` | Platform-ops outbox-backed audit capability. |
| `platform.notifications` | `available` | Platform-ops notification capability. |
| `runtime.env-provisioning` | `configuration-gated` | Requires environment provisioning and registered provider configuration. |
| `runtime.preview-deployments` | `configuration-gated` | Depends on deployment history and provider preview support. |
| `billing.usage-quotas` | `configuration-gated` | Requires the current billing and quota configuration. |

## Deployment scope

Hosted deployment is a deployment target, not a replacement for the pack identity. Current provider behavior is documented in the [provider map](/architecture/provider-map.generated.md) and provisioning [runbook](/runbooks/runbook-deployment-provisioning.md).

## Configuration and entitlements

Configuration narrows the capability set. The documented order is `build -> edition manifest -> deployment configuration -> tenant override`. The current backend capability endpoint remains the compatibility surface.

## Explicit non-support

Payment checkout, marketing-site behavior, and SaaS-specific entitlement resolution are not implemented as pack behavior in this backend. Do not infer them from the pack name.

## Ownership and verification

- Context owners: `identity-access`, `platform-ops`, `runtime`, and `billing` as shown in the capability matrix.
- Source: `docs/capabilities/registry.ts` and the owning context source paths.
- Verification: `npm run check:documentation`.
