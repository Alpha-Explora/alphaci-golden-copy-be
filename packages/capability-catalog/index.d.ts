export type Edition = "saas" | "edu" | "enterprise";
export type CapabilityMaturity = "stable" | "limited" | "not-implemented";
export type CapabilityKey =
  | "identity.workspaces"
  | "identity.hierarchy"
  | "identity.sso-scim"
  | "identity.lms-lti"
  | "identity.cohort-policy"
  | "identity.edu-provisioning"
  | "identity.ferpa-workflows"
  | "identity.edition-entitlements"
  | "platform.audit-events"
  | "platform.notifications"
  | "platform.data-residency"
  | "billing.subscription-gate"
  | "billing.usage-quotas"
  | "billing.checkout"
  | "runtime.env-provisioning"
  | "runtime.gcp-deployments"
  | "runtime.deployment-history"
  | "runtime.preview-deployments"
  | "runtime.drift-detection"
  | "runtime.drift-repair"
  | "runtime.managed-secrets"
  | "runtime.air-gap-packaging"
  | "runtime.customer-isolation"
  | "projects.sync-snapshots"
  | "projects.workflow-settings-preview"
  | "projects.workflow-update-pr"
  | "projects.target-management"
  | "pipelines.ci-run-tracking"
  | "pipelines.github-enterprise-server";

export interface CapabilityCatalogRecord {
  readonly key: CapabilityKey;
  readonly maturity: CapabilityMaturity;
  readonly editions: readonly Edition[];
  readonly requires: readonly CapabilityKey[];
}

export type CapabilityManifest = readonly CapabilityKey[];

export interface CapabilityCatalogPackage {
  readonly version: string;
  readonly catalog: readonly CapabilityCatalogRecord[];
  readonly manifests: Readonly<Record<Edition, CapabilityManifest>>;
}

export const version: string;
export const catalog: readonly CapabilityCatalogRecord[];
export const manifests: Readonly<Record<Edition, CapabilityManifest>>;
