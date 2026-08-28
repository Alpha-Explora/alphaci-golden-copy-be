export const CAPABILITIES = [
  {
    "key": "identity.workspaces",
    "context": "identity-access",
    "description": "Workspace membership and access management.",
    "maturity": "stable",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "workspaces.enabled"
  },
  {
    "key": "identity.hierarchy",
    "context": "identity-access",
    "description": "Hierarchy groups, systems, repositories, and assignments.",
    "maturity": "stable",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "hierarchy.enabled"
  },
  {
    "key": "platform.audit-events",
    "context": "platform-ops",
    "description": "Project audit event recording through the application outbox.",
    "maturity": "stable",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "auditEvents.enabled"
  },
  {
    "key": "platform.notifications",
    "context": "platform-ops",
    "description": "In-app notification requests and persistence.",
    "maturity": "stable",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "notifications.enabled"
  },
  {
    "key": "billing.usage-quotas",
    "context": "billing",
    "description": "Usage tracking and quota policy checks.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "usageQuotas.enabled"
  },
  {
    "key": "runtime.env-provisioning",
    "context": "runtime",
    "description": "Provider-backed deployment target and environment provisioning.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "envProvisioning.enabled plus provider configuration"
  },
  {
    "key": "runtime.deployment-history",
    "context": "runtime",
    "description": "Deployment history read model exposed through the Runtime context.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "deploymentHistory.enabled"
  },
  {
    "key": "runtime.preview-deployments",
    "context": "runtime",
    "description": "Branch-scoped preview deployment grouping when the provider supports it.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "previewDeployments.enabled and deploymentHistory.enabled"
  },
  {
    "key": "runtime.drift-detection",
    "context": "runtime",
    "description": "Configuration drift detection using the current local or provider snapshot mode.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "driftDetection.enabled"
  },
  {
    "key": "runtime.drift-repair",
    "context": "runtime",
    "description": "Safe drift repair using the current configured repair mode.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "driftRepair.enabled"
  },
  {
    "key": "projects.sync-snapshots",
    "context": "projects",
    "description": "Project synchronization snapshot reads and findings.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "projectSyncSnapshots.enabled"
  },
  {
    "key": "projects.workflow-settings-preview",
    "context": "projects",
    "description": "Workflow settings preview and validation.",
    "maturity": "stable",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "workflowSettingsPreview.enabled"
  },
  {
    "key": "projects.workflow-update-pr",
    "context": "projects",
    "description": "Workflow update pull-request requests.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "workflowUpdatePr.enabled"
  },
  {
    "key": "projects.target-management",
    "context": "projects",
    "description": "Project target management composition with Runtime.",
    "maturity": "stable",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "projectTargetManagement.enabled"
  },
  {
    "key": "pipelines.ci-run-tracking",
    "context": "pipelines",
    "description": "CI run report ingestion and tracking.",
    "maturity": "limited",
    "editions": ["saas", "edu", "enterprise"],
    "configuration": "ciRunTracking.enabled"
  }
] as const;
