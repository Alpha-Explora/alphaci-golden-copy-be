#!/usr/bin/env node
'use strict';

/**
 * Enforces schema ownership for both migrations and repository inline SQL.
 *
 * Existing cross-context references are transition debt, so they are recorded
 * as exact schema.table pairs per file. A new table reference fails the gate;
 * adding a broad filename exemption is intentionally not supported.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const SOURCE_ROOTS = [path.join(ROOT, 'src'), path.join(ROOT, 'scripts')];

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

function pairs(entries) {
  return new Set(entries);
}

/** Historical migrations that must remain replayable without changing data. */
const LEGACY_MIGRATION_REFERENCES = new Map([
  [
    'billing/20260614000000_account_archive.sql',
    pairs(['identity.app_users']),
  ],
  [
    'billing/20260614000200_usage_quotas.sql',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'billing/20260712000000_billing_profiles.sql',
    pairs(['identity.app_users']),
  ],
  [
    'billing/20260713000200_workspace_subscriptions.sql',
    pairs(['orgs.workspaces', 'identity.app_users']),
  ],
  [
    'billing/20260714_payment_ledger.sql',
    pairs(['identity.app_users', 'orgs.workspaces']),
  ],
  [
    'identity-access/20260615000100_workspace_membership_completion.sql',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'identity-access/20260713061000_hierarchy_core.sql',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'identity-access/20260818000000_link_group_projects_to_hierarchy.sql',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'identity-access/20260824120000_backfill_hierarchy_links.sql',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'identity-access/20260617000000_enable_rls_exposed_tables.sql',
    pairs([
      'env_provisioning.provider_connections',
      'env_provisioning.project_env_var_metadata',
      'env_provisioning.project_deployment_targets',
      'ci.project_ci_tokens',
      'workflow.ci_run_reports',
      'audit.audit_events',
      'notifications.notifications',
      'notifications.notification_preferences',
      'github_app.github_installation_accounts',
      'projects.project_workflow_settings',
      'projects.project_workflow_update_requests',
    ]),
  ],
  [
    'pipelines/20260607000200_project_ci_tokens.sql',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'pipelines/20260614000100_ci_run_reports.sql',
    pairs(['identity.app_users']),
  ],
  [
    'platform-ops/20260614000300_workspaces_audit_notifications.sql',
    pairs(['orgs.workspaces', 'projects.provisioned_projects']),
  ],
  [
    'platform-ops/20260617000300_user_feedback.sql',
    pairs(['identity.app_users']),
  ],
  [
    'projects/20260609_backfill_projects_schema_from_public.sql',
    pairs([
      'identity.oauth_states',
      'identity.app_users',
      'public.app_users',
      'public.oauth_states',
      'billing.subscription_plans',
      'public.subscription_plans',
      'billing.user_subscriptions',
      'public.user_subscriptions',
      'public.workflow_generations',
      'public.provisioned_projects',
      'ci.project_ci_tokens',
      'public.project_ci_tokens',
      'github_app.github_installation_accounts',
      'public.github_installations',
      'github_app.github_installations',
      'public.github_installation_repos',
      'platform.outbox_events',
      'public.outbox_events',
    ]),
  ],
  [
    'projects/20260611192953_project_dashboard_snapshots.sql',
    pairs(['identity.app_users']),
  ],
  [
    'projects/20260611200404_workflow_settings_preview.sql',
    pairs(['identity.app_users']),
  ],
  [
    'projects/20260611202529_workflow_update_requests.sql',
    pairs(['identity.app_users']),
  ],
  [
    'projects/20260613_project_sync_findings.sql',
    pairs(['env_provisioning.project_deployment_targets']),
  ],
  [
    'runtime/20260608_env_provisioning.sql',
    pairs(['identity.app_users', 'projects.provisioned_projects']),
  ],
  [
    'runtime/20260701_gcp_runtime_expand_contract.sql',
    pairs([
      'orgs.workspaces',
      'projects.provisioned_projects',
      'identity.app_users',
      'billing_lifecycle.runtime_cost_summaries',
    ]),
  ],
]);

/** Current source-level transition seams, recorded per file and table. */
const TRANSITIONAL_SOURCE_REFERENCES = new Map([
  [
    'src/kernel/events/outbox.repository.ts',
    pairs(['platform.outbox_events']),
  ],
  [
    'src/modules/billing/usage/usage-quota.service.ts',
    pairs([
      'env_provisioning.project_deployment_targets',
      'env_provisioning.project_env_var_metadata',
      'identity.app_users',
      'projects.project_workflow_update_requests',
      'projects.provisioned_projects',
    ]),
  ],
  [
    'src/modules/identity-access/admin/admin.repository.ts',
    pairs([
      'projects.provisioned_projects',
      'workflow.ci_run_reports',
      'workflow.workflow_generations',
      'billing.user_subscriptions',
      'audit.audit_events',
    ]),
  ],
  [
    'src/modules/identity-access/hierarchy/group-activity.repository.ts',
    pairs(['audit.audit_events']),
  ],
  [
    'src/modules/identity-access/hierarchy/github-sync/github-access-sync.repository.ts',
    pairs(['identity.app_users']),
  ],
  [
    'src/modules/identity-access/hierarchy/groups/groups.repository.ts',
    pairs(['hierarchy.systems']),
  ],
  [
    'src/modules/identity-access/workspaces/workspaces.repository.ts',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'src/modules/pipelines/ci/ci-reports.service.ts',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'src/modules/pipelines/ci/infra/ci-tokens.repository.ts',
    pairs([
      'projects.provisioned_projects',
      'identity.app_users',
      'billing.user_subscriptions',
    ]),
  ],
  [
    'src/modules/platform-ops/audit/audit-events.repository.ts',
    pairs(['projects.provisioned_projects']),
  ],
  [
    'src/modules/platform-ops/feedback/feedback.repository.ts',
    pairs(['identity.app_users']),
  ],
  [
    'src/modules/projects/projects.repository.ts',
    pairs([
      'identity.app_users',
      'identity.platform_admins',
      'orgs.workspace_members',
      'hierarchy.repositories',
      'hierarchy.repository_assignments',
    ]),
  ],
  [
    'src/modules/runtime/infrastructure/deployment-targets.repository.ts',
    pairs(['projects.provisioned_projects', 'orgs.workspace_members']),
  ],
  [
    'src/modules/runtime/infrastructure/env-vars.repository.ts',
    pairs(['projects.provisioned_projects', 'orgs.workspace_members']),
  ],
  [
    'src/modules/runtime/infrastructure/repositories/project-sync-findings.repository.ts',
    pairs(['projects.project_sync_findings', 'projects.provisioned_projects']),
  ],
  [
    'scripts/check-github-team-setup.ts',
    pairs([
      'information_schema.columns',
      'identity.app_users',
      'projects.provisioned_projects',
      'orgs.workspaces',
      'hierarchy.repositories',
    ]),
  ],
  [
    'scripts/hierarchy-migrations.cjs',
    pairs(['information_schema.columns']),
  ],
]);

const SOURCE_SCRIPT_OWNERS = new Map([
  ['scripts/check-github-team-setup.ts', 'identity-access'],
  ['scripts/hierarchy-migrations.cjs', 'identity-access'],
]);

const SQL_REFERENCE_RE =
  /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM|REFERENCES|ALTER\s+TABLE|CREATE\s+TABLE|TRUNCATE\s+TABLE|DROP\s+TABLE)\s+(?:ONLY\s+)?(?:["']?([a-z_][a-z0-9_-]*)["']?\.)?["']?([a-z_][a-z0-9_-]*)["']?/gi;

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files;
}

function stripSqlComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) =>
      comment.replace(/[^\r\n]/g, ' '),
    )
    .replace(/--[^\r\n]*/g, (comment) => comment.replace(/[^\r\n]/g, ' '))
    // Inline SQL is embedded in TypeScript as well as SQL files. Remove its
    // line comments so prose such as "build from tsconfig" is not parsed as a
    // table reference. This intentionally preserves newlines for line output.
    .replace(/\/\/[^\r\n]*/g, (comment) => comment.replace(/[^\r\n]/g, ' '));
}

function collectQualifiedReferences(text) {
  const sanitized = stripSqlComments(text);
  const references = [];
  SQL_REFERENCE_RE.lastIndex = 0;
  let match;
  while ((match = SQL_REFERENCE_RE.exec(sanitized)) !== null) {
    if (!match[1]) continue;
    references.push({
      reference: `${match[1].toLowerCase()}.${match[2].toLowerCase()}`,
      line: sanitized.slice(0, match.index).split(/\r?\n/).length,
    });
  }
  return references;
}

function moduleOwnerOf(relPath) {
  const match = /^src\/modules\/([^/]+)\//.exec(relPath);
  return match ? match[1] : SOURCE_SCRIPT_OWNERS.get(relPath) ?? null;
}

function isAllowedReference(owner, reference, legacyReferences) {
  const schema = reference.split('.')[0];
  if (ALLOWED_SCHEMAS_BY_OWNER[owner]?.has(schema)) return true;
  return legacyReferences.has(reference);
}

function migrationViolations() {
  const violations = [];
  for (const ownerEntry of fs.readdirSync(MIGRATIONS, {
    withFileTypes: true,
  })) {
    if (!ownerEntry.isDirectory()) continue;
    const owner = ownerEntry.name;
    const allowed = ALLOWED_SCHEMAS_BY_OWNER[owner];
    const ownerDir = path.join(MIGRATIONS, owner);
    if (!allowed) {
      violations.push(`${owner}: unknown migration owner directory`);
      continue;
    }
    for (const file of fs
      .readdirSync(ownerDir)
      .filter((name) => name.endsWith('.sql'))) {
      const rel = `${owner}/${file}`;
      const text = fs.readFileSync(path.join(ownerDir, file), 'utf8');
      const legacy = new Set(LEGACY_MIGRATION_REFERENCES.get(rel) ?? []);
      for (const reference of collectQualifiedReferences(text)) {
        if (isAllowedReference(owner, reference.reference, legacy)) continue;
        violations.push(
          `${rel}:${reference.line}: ${reference.reference} is outside ${owner}`,
        );
      }
    }
  }
  return violations;
}

function sourceViolations() {
  const violations = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of filesUnder(root)) {
      if (
        !['.ts', '.js', '.cjs', '.mjs'].includes(path.extname(file)) ||
        file.endsWith('.spec.ts')
      ) {
        continue;
      }
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const owner = moduleOwnerOf(rel);
      if (!owner) continue;
      const legacy = new Set(TRANSITIONAL_SOURCE_REFERENCES.get(rel) ?? []);
      const allowedSchemas = ALLOWED_SCHEMAS_BY_OWNER[owner];
      for (const reference of collectQualifiedReferences(
        fs.readFileSync(file, 'utf8'),
      )) {
        const schema = reference.reference.split('.')[0];
        if (allowedSchemas?.has(schema) || legacy.has(reference.reference)) {
          continue;
        }
        violations.push(
          `${rel}:${reference.line}: ${reference.reference} is outside ${owner}`,
        );
      }
    }
  }
  return violations;
}

function main() {
  const migrationErrors = migrationViolations();
  const sourceErrors = sourceViolations();
  const violations = [...migrationErrors, ...sourceErrors];

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        { migrations: migrationErrors, source: sourceErrors },
        null,
        2,
      ),
    );
    process.exit(violations.length > 0 ? 1 : 0);
  }

  if (violations.length) {
    console.error(
      `Schema ownership check failed: ${violations.length} violation(s).`,
    );
    violations.forEach((violation) => console.error(`  ${violation}`));
    process.exit(1);
  }

  const migrationCount = filesUnder(MIGRATIONS).filter((file) =>
    file.endsWith('.sql'),
  ).length;
  console.log(
    `Schema ownership OK (${migrationCount} migrations, ${Object.keys(ALLOWED_SCHEMAS_BY_OWNER).length} owners, inline SQL checked).`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  collectQualifiedReferences,
  isAllowedReference,
  stripSqlComments,
};
