#!/usr/bin/env node
'use strict';

/**
 * Enforces the migration owner/schema map. Existing cross-context FKs are
 * explicitly recorded as legacy because this task must not rewrite schema
 * semantics; new migrations must stay within their owning context.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const ALLOWED_SCHEMAS_BY_OWNER = {
  'identity-access': new Set(['identity', 'orgs', 'hierarchy']),
  projects: new Set(['projects', 'workflow']),
  pipelines: new Set(['github_app', 'ci', 'workflow']),
  runtime: new Set([
    'runtime',
    'env_provisioning',
    'runtime_deployments',
    'runtime_domains',
    'runtime_secrets',
    'gcp_operations',
  ]),
  billing: new Set(['billing', 'usage', 'billing_lifecycle']),
  'platform-ops': new Set(['platform', 'audit', 'notifications', 'support']),
};

const LEGACY_CROSS_CONTEXT = new Set([
  '20260607000200_project_ci_tokens.sql',
  '20260608_env_provisioning.sql',
  '20260609_backfill_projects_schema_from_public.sql',
  '20260611192953_project_dashboard_snapshots.sql',
  '20260611200404_workflow_settings_preview.sql',
  '20260611202529_workflow_update_requests.sql',
  '20260613_project_sync_findings.sql',
  '20260614000000_account_archive.sql',
  '20260614000100_ci_run_reports.sql',
  '20260614000200_usage_quotas.sql',
  '20260614000300_workspaces_audit_notifications.sql',
  '20260615000100_workspace_membership_completion.sql',
  '20260617000000_enable_rls_exposed_tables.sql',
  '20260617000300_user_feedback.sql',
  '20260701_gcp_runtime_expand_contract.sql',
  '20260712000000_billing_profiles.sql',
  '20260713000200_workspace_subscriptions.sql',
  '20260713061000_hierarchy_core.sql',
  '20260713063000_hierarchy_config_broker.sql',
  '20260713064000_hierarchy_communication_stub.sql',
  '20260714_payment_ledger.sql',
  '20260818000000_link_group_projects_to_hierarchy.sql',
  '20260824120000_backfill_hierarchy_links.sql',
]);

const REF_RE = /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM|REFERENCES)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;
const violations = [];
const migrations = [];

for (const owner of fs.readdirSync(MIGRATIONS)) {
  const dir = path.join(MIGRATIONS, owner);
  if (!fs.statSync(dir).isDirectory()) continue;
  const allowed = ALLOWED_SCHEMAS_BY_OWNER[owner];
  if (!allowed) {
    violations.push(`${owner}: unknown migration owner directory`);
    continue;
  }
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
    migrations.push(`${owner}/${file}`);
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    REF_RE.lastIndex = 0;
    let match;
    while ((match = REF_RE.exec(text))) {
      const schema = match[1].toLowerCase();
      if (
        allowed.has(schema) ||
        (schema === 'public' && LEGACY_CROSS_CONTEXT.has(file)) ||
        LEGACY_CROSS_CONTEXT.has(file)
      ) continue;
      violations.push(`${owner}/${file}: ${schema}.${match[2]} is outside ${owner}`);
    }
  }
}

if (violations.length) {
  console.error(`Schema ownership check failed: ${violations.length} violation(s).`);
  violations.forEach((violation) => console.error(`  ${violation}`));
  process.exit(1);
}
console.log(`Schema ownership OK (${migrations.length} migrations, ${Object.keys(ALLOWED_SCHEMAS_BY_OWNER).length} owners).`);
