export const CAPABILITIES = [
  {
    "key": "identity.workspaces",
    "context": "identity-access",
    "description": "Workspace membership and access management.",
    "maturity": "stable",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "workspaces.enabled",
    "configurationFlags": [
      "workspaces.enabled"
    ],
    "requires": []
  },
  {
    "key": "identity.hierarchy",
    "context": "identity-access",
    "description": "Hierarchy groups, systems, repositories, and assignments.",
    "maturity": "stable",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "hierarchy.enabled",
    "configurationFlags": [
      "hierarchy.enabled"
    ],
    "requires": []
  },
  {
    "key": "platform.audit-events",
    "context": "platform-ops",
    "description": "Project audit event recording through the application outbox.",
    "maturity": "stable",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "auditEvents.enabled",
    "configurationFlags": [
      "auditEvents.enabled"
    ],
    "requires": []
  },
  {
    "key": "platform.notifications",
    "context": "platform-ops",
    "description": "In-app notification requests and persistence.",
    "maturity": "stable",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "notifications.enabled",
    "configurationFlags": [
      "notifications.enabled"
    ],
    "requires": []
  },
  {
    "key": "billing.subscription-gate",
    "context": "billing",
    "description": "Subscription entitlement gating for authenticated access and CI run validation.",
    "maturity": "stable",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "subscription.gateEnabled",
    "configurationFlags": [
      "subscription.gateEnabled"
    ],
    "requires": []
  },
  {
    "key": "billing.usage-quotas",
    "context": "billing",
    "description": "Usage tracking and quota policy checks.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "usageQuotas.enabled",
    "configurationFlags": [
      "usageQuotas.enabled"
    ],
    "requires": []
  },
  {
    "key": "runtime.env-provisioning",
    "context": "runtime",
    "description": "Provider-backed deployment target and environment provisioning.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "envProvisioning.enabled plus provider configuration",
    "configurationFlags": [
      "envProvisioning.enabled"
    ],
    "requires": []
  },
  {
    "key": "runtime.gcp-deployments",
    "context": "runtime",
    "description": "Google Cloud deployment provider, including optional dedicated per-customer projects.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "gcpDeployments.enabled plus GCP provider configuration",
    "configurationFlags": [
      "gcpDeployments.enabled",
      "gcpDeployments.dedicatedProjectsEnabled"
    ],
    "requires": []
  },
  {
    "key": "runtime.deployment-history",
    "context": "runtime",
    "description": "Deployment history read model exposed through the Runtime context.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "deploymentHistory.enabled",
    "configurationFlags": [
      "deploymentHistory.enabled",
      "deploymentHistory.liveProvidersEnabled"
    ],
    "requires": []
  },
  {
    "key": "runtime.preview-deployments",
    "context": "runtime",
    "description": "Branch-scoped preview deployment grouping when the provider supports it.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "previewDeployments.enabled and deploymentHistory.enabled",
    "configurationFlags": [
      "previewDeployments.enabled"
    ],
    "requires": [
      "runtime.deployment-history"
    ]
  },
  {
    "key": "runtime.drift-detection",
    "context": "runtime",
    "description": "Configuration drift detection using the current local or provider snapshot mode.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "driftDetection.enabled",
    "configurationFlags": [
      "driftDetection.enabled",
      "driftLiveChecks.enabled"
    ],
    "requires": []
  },
  {
    "key": "runtime.drift-repair",
    "context": "runtime",
    "description": "Safe drift repair using the current configured repair mode.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "driftRepair.enabled",
    "configurationFlags": [
      "driftRepair.enabled",
      "driftRepair.liveRepairEnabled"
    ],
    "requires": []
  },
  {
    "key": "projects.sync-snapshots",
    "context": "projects",
    "description": "Project synchronization snapshot reads and findings.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "projectSyncSnapshots.enabled",
    "configurationFlags": [
      "projectSyncSnapshots.enabled",
      "projectSyncSnapshots.liveGithubEnabled",
      "projectSyncSnapshots.liveProvidersEnabled"
    ],
    "requires": []
  },
  {
    "key": "projects.workflow-settings-preview",
    "context": "projects",
    "description": "Workflow settings preview and validation.",
    "maturity": "stable",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "workflowSettingsPreview.enabled",
    "configurationFlags": [
      "workflowSettingsPreview.enabled"
    ],
    "requires": []
  },
  {
    "key": "projects.workflow-update-pr",
    "context": "projects",
    "description": "Workflow update pull-request requests.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "workflowUpdatePr.enabled",
    "configurationFlags": [
      "workflowUpdatePr.enabled"
    ],
    "requires": []
  },
  {
    "key": "projects.target-management",
    "context": "projects",
    "description": "Project target management composition with Runtime.",
    "maturity": "stable",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "projectTargetManagement.enabled",
    "configurationFlags": [
      "projectTargetManagement.enabled"
    ],
    "requires": []
  },
  {
    "key": "pipelines.ci-run-tracking",
    "context": "pipelines",
    "description": "CI run report ingestion and tracking.",
    "maturity": "limited",
    "editions": [
      "saas",
      "edu",
      "enterprise"
    ],
    "configuration": "ciRunTracking.enabled",
    "configurationFlags": [
      "ciRunTracking.enabled",
      "ciRunTracking.liveGithubEnabled"
    ],
    "requires": []
  }
] as const;
