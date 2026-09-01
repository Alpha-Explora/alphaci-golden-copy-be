---
type: "Composition Pack"
title: "Enterprise pack"
description: "Current Enterprise composition reference using the common pack contract."
tags: [packs, enterprise, composition]
status: stable
sources:
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Common pack contract"
  - id: capability-matrix
    resource: "/capabilities/capability-matrix.generated.md"
    title: "Current capability matrix"
---
# Enterprise pack

## Identity

- Pack ID: `enterprise`
- Display name: `Enterprise`

## Current composition

- Documentation status: `documentation-only`
- Runtime selection behavior: No pack-selection resolver is implemented in this backend.
- Current backend applicability: The same six-context backend supports configured provider integrations, workspace and hierarchy controls, project workflows, CI reporting, billing, and platform operations.

## Capability status

| Capability key | Status | Evidence or limit |
|---|---|---|
| `identity.workspaces` | `available` | Workspace access is owned by identity-access. |
| `identity.hierarchy` | `available` | Repository hierarchy and assignment behavior is owned by identity-access. |
| `runtime.env-provisioning` | `configuration-gated` | Provider and environment configuration are required. |
| `runtime.deployment-history` | `configuration-gated` | Current history mode is configuration-controlled. |
| `projects.target-management` | `available` | Project target composition is exposed through current context contracts. |
| `platform.audit-events` | `available` | Audit recording is outbox-backed and configuration-controlled. |

## Deployment scope

Enterprise is an edition composition reference. A customer-managed deployment target remains separate from edition identity. The current Runtime provider and GCP operational scope are described in the [provider map](/architecture/provider-map.generated.md) and [provisioning runbook](/runbooks/runbook-deployment-provisioning.md).

## Configuration and entitlements

The narrowing order is `build -> edition manifest -> deployment configuration -> tenant override`. The current backend does not resolve Enterprise-specific entitlements at runtime; this profile records shared current capabilities and their limits.

## Explicit non-support

Air-gap packaging, Vault integration, GHES integration, SSO/SCIM provisioning, customer-specific data residency controls, and customer-managed operational isolation are not implemented as Enterprise pack behavior in this backend.

## Ownership and verification

- Context owners: `identity-access`, `projects`, `runtime`, and `platform-ops` as shown in the capability matrix.
- Source: `docs/capabilities/registry.ts` and the owning context source paths.
- Verification: `npm run check:documentation`.
