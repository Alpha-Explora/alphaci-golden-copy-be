---
type: "Capability Map"
title: "Capability matrix"
description: "Generated documentation inventory of current capability keys and their compatibility posture."
tags: [capabilities, map, packs]
status: stable
sources:
  - id: "capability-registry"
    resource: "docs/capabilities/registry.ts"
    title: "Documentation capability registry"
  - id: "capability-gate"
    resource: "scripts/check-capabilities.cjs"
    title: "Capability registry gate"
  - id: "capability-endpoint"
    resource: "src/modules/identity-access/capabilities/capabilities.controller.ts"
    title: "Compatibility capability endpoint"
---

# Capability matrix

This matrix is generated from the documentation registry at `docs/capabilities/registry.ts`. It describes current compatibility keys and does not replace the existing `/api/v1/capabilities` response or implement entitlement resolution.

| Capability key | Context | Description | Maturity | Editions with documented applicability | Configuration source |
|---|---|---|---|---|---|
| `identity.workspaces` | `identity-access` | Workspace membership and access management. | stable | saas, edu, enterprise | workspaces.enabled |
| `identity.hierarchy` | `identity-access` | Hierarchy groups, systems, repositories, and assignments. | stable | saas, edu, enterprise | hierarchy.enabled |
| `identity.sso-scim` | `identity-access` | Single sign-on and SCIM user provisioning. | not-implemented | enterprise | Not implemented in this backend. No AppConfig flag. |
| `identity.lms-lti` | `identity-access` | LMS and LTI education-platform integrations. | not-implemented | edu | Not implemented in this backend. No AppConfig flag. |
| `identity.cohort-policy` | `identity-access` | Cohort-specific access and policy rules. | not-implemented | edu | Not implemented in this backend. No AppConfig flag. |
| `identity.edu-provisioning` | `identity-access` | Education-specific identity provisioning. | not-implemented | edu | Not implemented in this backend. No AppConfig flag. |
| `identity.ferpa-workflows` | `identity-access` | FERPA-oriented education workflow automation. | not-implemented | edu | Not implemented in this backend. No AppConfig flag. |
| `identity.edition-entitlements` | `identity-access` | Runtime edition and pack entitlement resolution. | not-implemented | saas, edu, enterprise | Not implemented in this backend. No AppConfig flag. |
| `platform.audit-events` | `platform-ops` | Project audit event recording through the application outbox. | stable | saas, edu, enterprise | auditEvents.enabled |
| `platform.notifications` | `platform-ops` | In-app notification requests and persistence. | stable | saas, edu, enterprise | notifications.enabled |
| `platform.data-residency` | `platform-ops` | Customer-specific data-location controls. | not-implemented | enterprise | Not implemented in this backend. No AppConfig flag. |
| `billing.subscription-gate` | `billing` | Subscription entitlement gating for authenticated access and CI run validation. | stable | saas, edu, enterprise | subscription.gateEnabled |
| `billing.usage-quotas` | `billing` | Usage tracking and quota policy checks. | limited | saas, edu, enterprise | usageQuotas.enabled |
| `billing.checkout` | `billing` | Self-serve payment checkout. | not-implemented | saas | Not implemented in this backend. No AppConfig flag. |
| `runtime.env-provisioning` | `runtime` | Provider-backed deployment target and environment provisioning. | limited | saas, edu, enterprise | envProvisioning.enabled plus provider configuration |
| `runtime.gcp-deployments` | `runtime` | Google Cloud deployment provider, including optional dedicated per-customer projects. | limited | saas, edu, enterprise | gcpDeployments.enabled plus GCP provider configuration |
| `runtime.deployment-history` | `runtime` | Deployment history read model exposed through the Runtime context. | limited | saas, edu, enterprise | deploymentHistory.enabled |
| `runtime.preview-deployments` | `runtime` | Branch-scoped preview deployment grouping when the provider supports it. | limited | saas, edu, enterprise | previewDeployments.enabled and deploymentHistory.enabled |
| `runtime.drift-detection` | `runtime` | Configuration drift detection using the current local or provider snapshot mode. | limited | saas, edu, enterprise | driftDetection.enabled |
| `runtime.drift-repair` | `runtime` | Safe drift repair using the current configured repair mode. | limited | saas, edu, enterprise | driftRepair.enabled |
| `runtime.managed-secrets` | `runtime` | Managed secret storage, including Vault integration. | not-implemented | enterprise | Not implemented in this backend. No AppConfig flag. |
| `runtime.air-gap-packaging` | `runtime` | Air-gap packaging of the application as a deployment target. | not-implemented | enterprise | Not implemented in this backend. No AppConfig flag. |
| `runtime.customer-isolation` | `runtime` | Customer-managed operational isolation as a tenancy option. | not-implemented | enterprise | Not implemented in this backend. No AppConfig flag. |
| `projects.sync-snapshots` | `projects` | Project synchronization snapshot reads and findings. | limited | saas, edu, enterprise | projectSyncSnapshots.enabled |
| `projects.workflow-settings-preview` | `projects` | Workflow settings preview and validation. | stable | saas, edu, enterprise | workflowSettingsPreview.enabled |
| `projects.workflow-update-pr` | `projects` | Workflow update pull-request requests. | limited | saas, edu, enterprise | workflowUpdatePr.enabled |
| `projects.target-management` | `projects` | Project target management composition with Runtime. | stable | saas, edu, enterprise | projectTargetManagement.enabled |
| `pipelines.ci-run-tracking` | `pipelines` | CI run report ingestion and tracking. | limited | saas, edu, enterprise | ciRunTracking.enabled |
| `pipelines.github-enterprise-server` | `pipelines` | GitHub Enterprise Server repository and CI integration. | not-implemented | enterprise | Not implemented in this backend. No AppConfig flag. |

## Interpretation

- **stable** means the compatibility surface is present in the current repository.
- **limited** means the key is present but its live adapter or provider behavior is intentionally limited or configuration-gated.
- **not-implemented** means the product area is explicitly recorded as absent from this backend; it is not an entitlement claim.

Pack profiles list every key in this table, in this order. Pack status is derived from maturity and edition applicability: `not-applicable` means the pack does not include the capability; `not-implemented` means the pack includes it and the backend does not provide it. Pack-specific gaps that are not registry keys stay in Explicit non-support.
