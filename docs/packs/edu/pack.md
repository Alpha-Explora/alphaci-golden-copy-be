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

- Build profile: `hosted-edu` (`edu`)
- Runtime selection behavior: `ALPHACI_EDITION=edu` selects the EDU manifest within the hosted-EDU build ceiling.
- Artifact inclusion inventory: the hosted-EDU artifact includes `src/modules/identity-access/auth/edu` and the EDU pack marker while excluding SaaS and Enterprise pack source roots.
- Current backend applicability: the identity-access context contains the limited EDU authentication slice. SIS/LMS provisioning, roster import, and broader EDU authorization remain deferred.

## Capability status

This table lists every current registry capability in registry order. Status is derived from capability maturity and edition applicability. Pack-specific gaps that are not registry keys stay in Explicit non-support.

| Capability key | Status | Evidence or limit |
|---|---|---|
| `identity.workspaces` | `available` | Workspace membership and access management. Configuration: workspaces.enabled. |
| `identity.hierarchy` | `available` | Hierarchy groups, systems, repositories, and assignments. Configuration: hierarchy.enabled. |
| `identity.sso-scim` | `not-applicable` | Not part of this pack composition. |
| `identity.lms-lti` | `not-implemented` | LMS and LTI education-platform integrations. Not implemented in this backend. |
| `identity.cohort-policy` | `not-implemented` | Cohort-specific access and policy rules. Not implemented in this backend. |
| `identity.edu-provisioning` | `not-implemented` | Education-specific identity provisioning. Not implemented in this backend. |
| `identity.ferpa-workflows` | `not-implemented` | FERPA-oriented education workflow automation. Not implemented in this backend. |
| `identity.edition-entitlements` | `not-implemented` | Runtime edition and pack entitlement resolution. Not implemented in this backend. |
| `identity.self-serve-auth` | `not-applicable` | Not part of this pack composition. |
| `identity.edu-auth` | `configuration-gated` | EDU Supabase-backed sign-in, school-email signup, recovery, staff GitHub linking, and server-authoritative lab selection. Configuration: `AUTH_EDU_ENABLED`, `EDU_SUPABASE_*`, `EDU_STUDENT_EMAIL_DOMAINS`, and isolated `EDU_GITHUB_*` values. |
| `platform.audit-events` | `available` | Project audit event recording through the application outbox. Configuration: auditEvents.enabled. |
| `platform.notifications` | `available` | In-app notification requests and persistence. Configuration: notifications.enabled. |
| `platform.data-residency` | `not-applicable` | Not part of this pack composition. |
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

EDU is an edition composition reference with a physically isolated hosted-EDU artifact. An institution-hosted or shared deployment target remains a separate deployment value. Provider behavior is documented in the [provider map](/architecture/provider-map.generated.md).

## Configuration and entitlements

The narrowing order is `build profile -> edition manifest -> deployment configuration -> tenant override`. `ALPHACI_BUILD_PROFILE` defaults safely to `enterprise`; `hosted-edu` must be selected explicitly. `AUTH_EDU_ENABLED` defaults on only for the EDU edition and can be set to `false` for a staged disable. EDU-specific entitlements, roster import, SIS/LMS provisioning, and live GitHub lab operations remain out of scope for this slice.

## Explicit non-support

No additional non-registry product areas. Catalog rows with status `not-implemented` plus roster import and SIS/LMS provisioning are the current EDU product gaps in this backend.

## Ownership and verification

- Context owners: `identity-access`, `projects`, `pipelines`, `runtime`, `billing`, and `platform-ops` as shown in the capability matrix.
- Source: `src/kernel/composition/capability-registry.ts`, `src/kernel/composition/manifests.ts`, and the owning context source paths.
- Verification: `npm run check:capabilities`, `npm run check:composition-profiles`.
