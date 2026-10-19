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

- Build profile: `enterprise` (`enterprise`)
- Runtime selection behavior: `ALPHACI_EDITION=enterprise` selects the Enterprise manifest within the Enterprise build ceiling.
- Artifact exclusion inventory: reserved hosted source roots/markers are absent from the Enterprise compiled profile artifact. The Enterprise client-policy implementation is real source under `src/packs/enterprise` and is loaded through the profile-keyed pack seam.
- Current backend applicability: The same six-context backend exposes the shared capability catalog. A customer-managed deployment target remains separate from edition identity.

## Capability status

This table lists every current registry capability in registry order. Status is derived from capability maturity and edition applicability. Pack-specific gaps that are not registry keys stay in Explicit non-support.

| Capability key | Status | Evidence or limit |
|---|---|---|
| `identity.workspaces` | `available` | Workspace membership and access management. Configuration: workspaces.enabled. |
| `identity.hierarchy` | `available` | Hierarchy groups, systems, repositories, and assignments. Configuration: hierarchy.enabled. |
| `identity.sso-scim` | `not-implemented` | Single sign-on and SCIM user provisioning. Not implemented in this backend. |
| `identity.lms-lti` | `not-applicable` | Not part of this pack composition. |
| `identity.cohort-policy` | `not-applicable` | Not part of this pack composition. |
| `identity.edu-provisioning` | `not-applicable` | Not part of this pack composition. |
| `identity.ferpa-workflows` | `not-applicable` | Not part of this pack composition. |
| `identity.edition-entitlements` | `not-implemented` | Runtime edition and pack entitlement resolution. Not implemented in this backend. |
| `platform.audit-events` | `available` | Project audit event recording through the application outbox. Configuration: auditEvents.enabled. |
| `platform.notifications` | `available` | In-app notification requests and persistence. Configuration: notifications.enabled. |
| `platform.data-residency` | `not-implemented` | Customer-specific data-location controls. Not implemented in this backend. |
| `platform.public-site` | `not-applicable` | Not part of this pack composition. |
| `billing.subscription-gate` | `available` | Subscription entitlement gating for authenticated access and CI run validation. Configuration: subscription.gateEnabled. |
| `billing.usage-quotas` | `configuration-gated` | Usage tracking and quota policy checks. Configuration: usageQuotas.enabled. |
| `billing.checkout` | `not-applicable` | Not part of this pack composition. |
| `runtime.env-provisioning` | `configuration-gated` | Provider-backed deployment target and environment provisioning. Configuration: envProvisioning.enabled plus provider configuration. |
| `runtime.gcp-deployments` | `configuration-gated` | Google Cloud deployment provider, including optional dedicated per-customer projects. Configuration: gcpDeployments.enabled plus GCP provider configuration. |
| `runtime.deployment-history` | `configuration-gated` | Deployment history read model exposed through the Runtime context. Configuration: deploymentHistory.enabled. |
| `runtime.preview-deployments` | `configuration-gated` | Branch-scoped preview deployment grouping when the provider supports it. Configuration: previewDeployments.enabled and deploymentHistory.enabled. |
| `runtime.drift-detection` | `configuration-gated` | Configuration drift detection using the current local or provider snapshot mode. Configuration: driftDetection.enabled. |
| `runtime.drift-repair` | `configuration-gated` | Safe drift repair using the current configured repair mode. Configuration: driftRepair.enabled. |
| `runtime.managed-secrets` | `not-implemented` | Managed secret storage, including Vault integration. Not implemented in this backend. |
| `runtime.air-gap-packaging` | `not-implemented` | Air-gap packaging of the application as a deployment target. Not implemented in this backend. |
| `runtime.customer-isolation` | `not-implemented` | Customer-managed operational isolation as a tenancy option. Not implemented in this backend. |
| `runtime.client-composition` | `configuration-gated` | Enterprise client composition through a declared or deployment-mounted deny-only policy. Configuration: `ALPHACI_CLIENT` or `ALPHACI_CLIENT_CONFIG`; read-only projection at `/settings`. |
| `projects.sync-snapshots` | `configuration-gated` | Project synchronization snapshot reads and findings. Configuration: projectSyncSnapshots.enabled. |
| `projects.workflow-settings-preview` | `available` | Workflow settings preview and validation. Configuration: workflowSettingsPreview.enabled. |
| `projects.workflow-update-pr` | `configuration-gated` | Workflow update pull-request requests. Configuration: workflowUpdatePr.enabled. |
| `projects.target-management` | `available` | Project target management composition with Runtime. Configuration: projectTargetManagement.enabled. |
| `projects.qa-checklists` | `configuration-gated` | QA checklist definitions and per-project sharing. Configuration: qaChecklists.enabled. |
| `pipelines.ci-run-tracking` | `configuration-gated` | CI run report ingestion and tracking. Configuration: ciRunTracking.enabled. |
| `pipelines.github-enterprise-server` | `not-implemented` | GitHub Enterprise Server repository and CI integration. Not implemented in this backend. |

## Deployment scope

Enterprise is an edition composition reference. A customer-managed deployment target remains separate from edition identity. `runtime.client-composition` narrows the Enterprise manifest with a deny-only client policy selected at startup; it does not provide air-gap packaging or customer isolation. `runtime.air-gap-packaging` is a deployment-target capability composed into this pack; `runtime.customer-isolation` is a tenancy capability composed into this pack. Neither value replaces the Enterprise edition identity. The self-hosted appliance under `deploy/selfhost/` runs this edition with `ALPHACI_DEPLOYMENT_MODE=selfhosted`; the deployment mode is a separate axis and does not change the manifest. The current Runtime provider and GCP operational scope are described in the [provider map](/architecture/provider-map.generated.md) and [provisioning runbook](/runbooks/runbook-deployment-provisioning.md).

## Configuration and entitlements

The narrowing order is `build profile -> edition manifest -> client policy -> deployment configuration -> tenant override`. `ALPHACI_BUILD_PROFILE` defaults to `enterprise`, preserving the existing Enterprise-first startup behavior. Enterprise-specific entitlements remain out of scope.

## Explicit non-support

No additional non-registry product areas. Catalog rows with status `not-implemented` are the current Enterprise product gaps in this backend.

## Ownership and verification

- Context owners: `identity-access`, `projects`, `pipelines`, `runtime`, `billing`, and `platform-ops` as shown in the capability matrix.
- Source: `src/kernel/composition/capability-registry.ts`, `src/kernel/composition/manifests.ts`, and the owning context source paths.
- Verification: `npm run check:capabilities`, `npm run check:composition-profiles`.
