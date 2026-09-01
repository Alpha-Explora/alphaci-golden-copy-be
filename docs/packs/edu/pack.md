---
type: "Composition Pack"
title: "EDU pack"
description: "Current EDU composition reference using the common pack contract."
tags: [packs, edu, composition]
status: stable
sources:
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Common pack contract"
  - id: capability-matrix
    resource: "/capabilities/capability-matrix.generated.md"
    title: "Current capability matrix"
---
# EDU pack

## Identity

- Pack ID: `edu`
- Display name: `EDU`

## Current composition

- Documentation status: `documentation-only`
- Runtime selection behavior: No pack-selection resolver is implemented in this backend.
- Current backend applicability: The same six-context backend exposes shared workspace, hierarchy, project, pipeline, runtime, billing, and platform-ops capabilities where configured.

## Capability status

| Capability key | Status | Evidence or limit |
|---|---|---|
| `identity.workspaces` | `available` | Workspace membership is owned by identity-access. |
| `identity.hierarchy` | `available` | Hierarchy and repository assignment behavior is owned by identity-access. |
| `projects.workflow-settings-preview` | `available` | Workflow settings preview is configuration-controlled. |
| `pipelines.ci-run-tracking` | `configuration-gated` | Current compatibility mode may use local CI reporting. |
| `runtime.env-provisioning` | `configuration-gated` | Requires environment provisioning and a supported Runtime provider. |
| `billing.usage-quotas` | `configuration-gated` | Current quota policy is configuration-controlled. |

## Deployment scope

EDU is an edition composition reference. An institution-hosted or shared deployment target remains a separate deployment value. Provider behavior is documented in the [provider map](/architecture/provider-map.generated.md).

## Configuration and entitlements

The narrowing order is `build -> edition manifest -> deployment configuration -> tenant override`. The current backend does not resolve EDU-specific entitlements at runtime; this profile records the applicable shared capability surface only.

## Explicit non-support

LMS/LTI integrations, cohort-specific policy, FERPA workflow automation, and education-specific identity provisioning are not implemented in this backend. They require explicit product and integration work before being described as available.

## Ownership and verification

- Context owners: `identity-access`, `projects`, `pipelines`, `runtime`, and `billing` as shown in the capability matrix.
- Source: `docs/capabilities/registry.ts` and the owning context source paths.
- Verification: `npm run check:documentation`.
