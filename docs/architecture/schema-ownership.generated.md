---
type: "Schema Ownership Map"
title: "Database schema ownership map"
description: "Generated schema ownership and explicit transition-reference inventory."
tags: [architecture, database, schema, map]
status: stable
sources:
  - id: "ownership-source"
    resource: "scripts/check-schema-ownership.cjs"
    title: "Schema ownership gate"
  - id: "migration-source"
    resource: "supabase/migrations"
    title: "Current migration tree"
---

# Database schema ownership map

This map is generated from the owner and exact transition-reference data used by `scripts/check-schema-ownership.cjs`. It documents current ownership without changing schemas, roles, search paths, or migration replay order.

## Owners

| Owner | Schemas |
|---|---|
| `billing` | `billing`, `billing_lifecycle`, `usage` |
| `identity-access` | `hierarchy`, `identity`, `orgs` |
| `pipelines` | `ci`, `github_app`, `workflow` |
| `platform-ops` | `audit`, `notifications`, `platform`, `support` |
| `projects` | `projects`, `workflow` |
| `runtime` | `env_provisioning`, `gcp_operations`, `runtime`, `runtime_deployments`, `runtime_domains`, `runtime_secrets` |

`workflow` is intentionally listed for both Projects and Pipelines because the current database contains workflow-generation and CI-run tables. Ownership is table-level in the source gate where the distinction matters.

## Explicit migration transition references

These are exact file-to-schema.table allowances for historical migrations that must remain replayable and explicitly reviewed migration transitions. They are not blanket filename exemptions.

| Migration file | Allowed transition references |
|---|---|
| `billing/20260614000000_account_archive.sql` | `identity.app_users` |
| `billing/20260614000200_usage_quotas.sql` | `projects.provisioned_projects` |
| `billing/20260712000000_billing_profiles.sql` | `identity.app_users` |
| `billing/20260713000200_workspace_subscriptions.sql` | `identity.app_users`, `orgs.workspaces` |
| `billing/20260714_payment_ledger.sql` | `identity.app_users`, `orgs.workspaces` |
| `identity-access/20260606_domain_schema_bootstrap.sql` | `billing.subscription_events`, `billing.subscription_plans`, `billing.user_subscriptions`, `github_app.github_installation_accounts`, `github_app.github_installations`, `platform.outbox_events`, `projects.provisioned_projects`, `workflow.workflow_generations` |
| `identity-access/20260615000100_workspace_membership_completion.sql` | `projects.provisioned_projects` |
| `identity-access/20260617000000_enable_rls_exposed_tables.sql` | `audit.audit_events`, `ci.project_ci_tokens`, `env_provisioning.project_deployment_targets`, `env_provisioning.project_env_var_metadata`, `env_provisioning.provider_connections`, `github_app.github_installation_accounts`, `notifications.notification_preferences`, `notifications.notifications`, `projects.project_workflow_settings`, `projects.project_workflow_update_requests`, `workflow.ci_run_reports` |
| `identity-access/20260713061000_hierarchy_core.sql` | `projects.provisioned_projects` |
| `identity-access/20260818000000_link_group_projects_to_hierarchy.sql` | `projects.provisioned_projects` |
| `identity-access/20260824120000_backfill_hierarchy_links.sql` | `projects.provisioned_projects` |
| `pipelines/20260607000200_project_ci_tokens.sql` | `projects.provisioned_projects` |
| `pipelines/20260614000100_ci_run_reports.sql` | `identity.app_users` |
| `platform-ops/20260614000300_workspaces_audit_notifications.sql` | `orgs.workspace_members`, `orgs.workspaces`, `projects.provisioned_projects` |
| `platform-ops/20260617000300_user_feedback.sql` | `identity.app_users` |
| `projects/20260609_backfill_projects_schema_from_public.sql` | `billing.subscription_plans`, `billing.user_subscriptions`, `ci.project_ci_tokens`, `github_app.github_installation_accounts`, `github_app.github_installations`, `identity.app_users`, `identity.oauth_states`, `platform.outbox_events`, `public.app_users`, `public.github_installation_repos`, `public.github_installations`, `public.oauth_states`, `public.outbox_events`, `public.project_ci_tokens`, `public.provisioned_projects`, `public.subscription_plans`, `public.user_subscriptions`, `public.workflow_generations` |
| `projects/20260611192953_project_dashboard_snapshots.sql` | `identity.app_users` |
| `projects/20260611200404_workflow_settings_preview.sql` | `identity.app_users` |
| `projects/20260611202529_workflow_update_requests.sql` | `identity.app_users` |
| `projects/20260613_project_sync_findings.sql` | `env_provisioning.project_deployment_targets` |
| `projects/20260925050000_project_environments.sql` | `env_provisioning.project_deployment_targets` |
| `runtime/20260608_env_provisioning.sql` | `identity.app_users`, `projects.provisioned_projects` |
| `runtime/20260701_gcp_runtime_expand_contract.sql` | `billing_lifecycle.runtime_cost_summaries`, `identity.app_users`, `orgs.workspaces`, `projects.provisioned_projects` |
| `runtime/20260928100000_deployment_target_environments.sql` | `projects.project_environments` |
| `runtime/20260928200000_release_registry.sql` | `projects.project_environments`, `projects.provisioned_projects` |

## Explicit source transition references

These are exact source-file allowances for current cross-context reads or shared technical tables. New references fail the gate until ownership is reviewed and recorded precisely.

| Source file | Allowed transition references |
|---|---|
| `scripts/check-github-team-setup.ts` | `hierarchy.repositories`, `identity.app_users`, `information_schema.columns`, `orgs.workspaces`, `projects.provisioned_projects` |
| `scripts/hierarchy-migrations.cjs` | `information_schema.columns` |
| `src/kernel/events/outbox.repository.ts` | `platform.outbox_events` |
| `src/modules/billing/usage/application/usage-quota.service.ts` | `env_provisioning.project_deployment_targets`, `env_provisioning.project_env_var_metadata`, `identity.app_users`, `projects.project_workflow_update_requests`, `projects.provisioned_projects` |
| `src/modules/identity-access/admin/infrastructure/admin.repository.ts` | `audit.audit_events`, `billing.user_subscriptions`, `projects.provisioned_projects`, `workflow.ci_run_reports`, `workflow.workflow_generations` |
| `src/modules/identity-access/hierarchy/infrastructure/github-access-sync.repository.ts` | `identity.app_users` |
| `src/modules/identity-access/hierarchy/infrastructure/group-activity.repository.ts` | `audit.audit_events` |
| `src/modules/identity-access/hierarchy/infrastructure/groups.repository.ts` | `hierarchy.systems` |
| `src/modules/identity-access/workspaces/infrastructure/workspaces.repository.ts` | `projects.provisioned_projects` |
| `src/modules/pipelines/ci/application/ci-reports.service.ts` | `projects.provisioned_projects` |
| `src/modules/pipelines/ci/infrastructure/ci-tokens.repository.ts` | `billing.user_subscriptions`, `identity.app_users`, `projects.provisioned_projects` |
| `src/modules/platform-ops/audit/infrastructure/audit-events.repository.ts` | `projects.provisioned_projects` |
| `src/modules/platform-ops/feedback/infrastructure/feedback.repository.ts` | `identity.app_users` |
| `src/modules/projects/infrastructure/projects.repository.ts` | `hierarchy.repositories`, `hierarchy.repository_assignments`, `identity.app_users`, `identity.platform_admins`, `orgs.workspace_members` |
| `src/modules/runtime/infrastructure/repositories/deployment-targets.repository.ts` | `orgs.workspace_members`, `projects.provisioned_projects` |
| `src/modules/runtime/infrastructure/repositories/env-vars.repository.ts` | `orgs.workspace_members`, `projects.provisioned_projects` |
| `src/modules/runtime/infrastructure/repositories/project-sync-findings.repository.ts` | `projects.project_sync_findings`, `projects.provisioned_projects` |

## Verification

Run `npm run check:schema-ownership` and `npm run db:apply:all -- --dry-run`. The first checks qualified and resolvable inline SQL; the second verifies globally sorted migration replay order.
