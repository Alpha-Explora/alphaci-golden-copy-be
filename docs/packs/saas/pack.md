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

- Build profile: `hosted-saas` (`saas`)
- Runtime selection behavior: `ALPHACI_EDITION=saas` selects the SaaS manifest within the hosted-SaaS build ceiling.
- Artifact exclusion inventory: the hosted-SaaS artifact excludes the EDU auth source tree, Enterprise policy source, and their declared markers.
- Current backend applicability: the six-context backend exposes the shared capability catalog through a SaaS-only physical artifact ceiling.

## Capability status

This table lists every current registry capability in registry order. Status is derived from capability maturity and edition applicability. Pack-specific gaps that are not registry keys stay in Explicit non-support.

| Capability key | Status | Evidence or limit |
|---|---|---|
| `identity.workspaces` | `available` | Workspace membership and access management. Configuration: workspaces.enabled. |
| `identity.hierarchy` | `available` | Hierarchy groups, systems, repositories, and assignments. Configuration: hierarchy.enabled. |
| `identity.sso-scim` | `not-applicable` | Not part of this pack composition. |
| `identity.lms-lti` | `not-applicable` | Not part of this pack composition. |
| `identity.cohort-policy` | `not-applicable` | Not part of this pack composition. |
| `identity.edu-provisioning` | `not-applicable` | Not part of this pack composition. |
| `identity.ferpa-workflows` | `not-applicable` | Not part of this pack composition. |
| `identity.edition-entitlements` | `not-implemented` | Runtime edition and pack entitlement resolution. Not implemented in this backend. |
| `identity.self-serve-auth` | `configuration-gated` | Self-serve sign-in and registration: email and password credentials, Google sign-in, and the public signup flow. SaaS-only email-code delivery via AUTH_EMAIL_CODE_DELIVERY; optional Google OAuth via GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL. Billing checkout remains deferred. |
| `identity.edu-auth` | `not-applicable` | Not part of this pack composition. |
| `platform.audit-events` | `available` | Project audit event recording through the application outbox. Configuration: auditEvents.enabled. |
| `platform.notifications` | `available` | In-app notification requests and persistence. Configuration: notifications.enabled. |
| `platform.data-residency` | `not-applicable` | Not part of this pack composition. |
| `platform.public-site` | `not-implemented` | Public marketing site: landing, pricing, and guide pages served to unauthenticated visitors. Not implemented in this backend. |
| `billing.subscription-gate` | `available` | Subscription entitlement gating for authenticated access and CI run validation. Configuration: subscription.gateEnabled. |
| `billing.usage-quotas` | `configuration-gated` | Usage tracking and quota policy checks. Configuration: usageQuotas.enabled. |
| `billing.checkout` | `not-implemented` | Self-serve payment checkout. Not implemented in this backend. |
| `runtime.env-provisioning` | `configuration-gated` | Provider-backed deployment target and environment provisioning. Configuration: envProvisioning.enabled plus provider configuration. |
| `runtime.gcp-deployments` | `configuration-gated` | Google Cloud deployment provider, including optional dedicated per-customer projects. Configuration: gcpDeployments.enabled plus GCP provider configuration. |
| `runtime.deployment-history` | `configuration-gated` | Deployment history read model exposed through the Runtime context. Configuration: deploymentHistory.enabled. |
| `runtime.preview-deployments` | `configuration-gated` | Branch-scoped preview deployment grouping when the provider supports it. Configuration: previewDeployments.enabled and deploymentHistory.enabled. |
| `runtime.drift-detection` | `configuration-gated` | Configuration drift detection using the current local or provider snapshot mode. Configuration: driftDetection.enabled. |
| `runtime.drift-repair` | `configuration-gated` | Safe drift repair using the current configured repair mode. Configuration: driftRepair.enabled. |
| `runtime.managed-secrets` | `not-applicable` | Not part of this pack composition. |
| `runtime.air-gap-packaging` | `not-applicable` | Not part of this pack composition. |
| `runtime.customer-isolation` | `not-applicable` | Not part of this pack composition. |
| `runtime.client-composition` | `not-applicable` | Not part of this pack composition. |
| `projects.sync-snapshots` | `configuration-gated` | Project synchronization snapshot reads and findings. Configuration: projectSyncSnapshots.enabled. |
| `projects.workflow-settings-preview` | `available` | Workflow settings preview and validation. Configuration: workflowSettingsPreview.enabled. |
| `projects.workflow-update-pr` | `configuration-gated` | Workflow update pull-request requests. Configuration: workflowUpdatePr.enabled. |
| `projects.target-management` | `available` | Project target management composition with Runtime. Configuration: projectTargetManagement.enabled. |
| `pipelines.ci-run-tracking` | `configuration-gated` | CI run report ingestion and tracking. Configuration: ciRunTracking.enabled. |
| `pipelines.github-enterprise-server` | `not-applicable` | Not part of this pack composition. |

## Deployment scope

Hosted deployment is a deployment target, not a replacement for the pack identity. Current provider behavior is documented in the [provider map](/architecture/provider-map.generated.md) and provisioning [runbook](/runbooks/runbook-deployment-provisioning.md).

## Configuration and entitlements

Configuration narrows the capability set. The documented order is `build profile -> edition manifest -> deployment configuration -> tenant override`. `ALPHACI_BUILD_PROFILE` defaults safely to `enterprise`; `hosted-saas` must be selected explicitly. The current backend capability endpoint remains the compatibility surface.

## Explicit non-support

Marketing-site behavior is not a backend capability and is not a registry key. Catalog rows with status `not-implemented` are the current SaaS product gaps in this backend.

## Ownership and verification

- Context owners: `identity-access`, `projects`, `pipelines`, `runtime`, `billing`, and `platform-ops` as shown in the capability matrix.
- Source: `src/kernel/composition/capability-registry.ts`, `src/kernel/composition/manifests.ts`, and the owning context source paths.
- Verification: `npm run check:capabilities`, `npm run check:composition-profiles`.
