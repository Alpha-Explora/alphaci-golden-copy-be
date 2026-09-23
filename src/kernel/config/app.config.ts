import { registerAs } from '@nestjs/config';

import {
  authConfig,
  githubConfig,
  provisioningConfig,
  subscriptionConfig,
} from './app.config-slices';
import type { AppConfig } from './app.config.types';
import { resolveCentralWorkflowRepo } from './central-workflow';
import { parseCompositionConfig } from '#kernel/composition/composition-config.js';

export { authConfig, githubConfig, provisioningConfig, subscriptionConfig };
export type { AppConfig, GithubTeamRoleSyncMode } from './app.config.types';

function templatesConfig(env: NodeJS.ProcessEnv): AppConfig['templates'] {
  return {
    // Local default matches the checked-out sibling directory name. It
    // previously read '../cicd-workflow', which resolved for nobody: the
    // checkout is named alphaci-workflow, so the engine catalog silently threw
    // and every local run fell back to the hardcoded static catalog while
    // deployed instances loaded the real one. Local and deployed disagreed with
    // only a log warning to say so.
    repoPath: env['TEMPLATE_REPO_PATH'] ?? '../alphaci-workflow',
    // The templates are in workflow-templates/customer. The default named the
    // parent, which is a real directory holding only subfolders, so the loader
    // found no *.properties.json and every template lookup returned nothing —
    // the same failure the repoPath comment above describes, one level down.
    // Every deployment that worked was setting this explicitly to cover it.
    workflowDir: env['TEMPLATE_WORKFLOW_DIR'] ?? 'workflow-templates/customer',
    centralWorkflowRepo: resolveCentralWorkflowRepo(env),
  };
}

function gcpDeploymentsConfig(
  env: NodeJS.ProcessEnv,
): AppConfig['gcpDeployments'] {
  return {
    enabled: env['GCP_DEPLOYMENTS_ENABLED'] === 'true',
    sharedProjectId: env['GCP_SHARED_PROJECT_ID']?.trim() ?? '',
    region: env['GCP_REGION']?.trim() || 'asia-southeast1',
    artifactRegistryRepository:
      env['GCP_ARTIFACT_REGISTRY_REPOSITORY']?.trim() ?? '',
    workloadIdentityProvider:
      env['GCP_WORKLOAD_IDENTITY_PROVIDER']?.trim() ?? '',
    deployerServiceAccount: env['GCP_DEPLOYER_SERVICE_ACCOUNT']?.trim() ?? '',
    dedicatedProjectsEnabled: env['GCP_DEDICATED_PROJECTS_ENABLED'] === 'true',
  };
}

function featureFlagConfig(
  env: NodeJS.ProcessEnv,
): Pick<
  AppConfig,
  | 'projectSyncSnapshots'
  | 'workflowSettingsPreview'
  | 'workflowUpdatePr'
  | 'projectTargetManagement'
  | 'ciRunTracking'
  | 'deploymentHistory'
  | 'previewDeployments'
  | 'driftDetection'
  | 'driftRepair'
  | 'driftLiveChecks'
  | 'usageQuotas'
  | 'workspaces'
  | 'auditEvents'
  | 'notifications'
> {
  return {
    projectSyncSnapshots: {
      enabled: env['PROJECT_SYNC_SNAPSHOTS_ENABLED'] === 'true',
      liveGithubEnabled: env['PROJECT_SYNC_LIVE_GITHUB_ENABLED'] === 'true',
      liveProvidersEnabled:
        env['PROJECT_SYNC_LIVE_PROVIDERS_ENABLED'] === 'true',
    },
    workflowSettingsPreview: {
      enabled: env['WORKFLOW_SETTINGS_PREVIEW_ENABLED'] === 'true',
    },
    workflowUpdatePr: {
      enabled: env['WORKFLOW_UPDATE_PR_ENABLED'] === 'true',
    },
    projectTargetManagement: {
      enabled: env['PROJECT_TARGET_MANAGEMENT_ENABLED'] === 'true',
    },
    ciRunTracking: {
      enabled: env['CI_RUN_TRACKING_ENABLED'] === 'true',
      liveGithubEnabled: env['CI_RUN_LIVE_GITHUB_ENABLED'] !== 'false',
    },
    deploymentHistory: {
      enabled: env['DEPLOYMENT_HISTORY_ENABLED'] === 'true',
      liveProvidersEnabled:
        env['DEPLOYMENT_HISTORY_LIVE_PROVIDERS_ENABLED'] !== 'false',
    },
    previewDeployments: {
      enabled: env['PREVIEW_DEPLOYMENTS_ENABLED'] === 'true',
    },
    driftDetection: {
      enabled: env['DRIFT_DETECTION_ENABLED'] === 'true',
    },
    driftRepair: {
      enabled: env['DRIFT_REPAIR_ENABLED'] === 'true',
      liveRepairEnabled: env['DRIFT_LIVE_REPAIR_ENABLED'] === 'true',
    },
    driftLiveChecks: {
      enabled: env['DRIFT_LIVE_PROVIDER_CHECKS_ENABLED'] === 'true',
    },
    usageQuotas: {
      enabled: env['USAGE_QUOTAS_ENABLED'] === 'true',
    },
    workspaces: {
      enabled: env['WORKSPACES_ENABLED'] === 'true',
    },
    auditEvents: {
      enabled: env['AUDIT_EVENTS_ENABLED'] === 'true',
    },
    notifications: {
      enabled: env['NOTIFICATIONS_ENABLED'] === 'true',
    },
  };
}

function supabaseConfig(env: NodeJS.ProcessEnv): AppConfig['supabase'] {
  const dbCaCert = env['SUPABASE_DB_CA_CERT']?.trim();
  return {
    // Trim defensively. Every sibling secret is trimmed; this one was not,
    // so a trailing newline/space pasted into a host's env panel survived
    // into the connection string and could corrupt the parsed dbname or
    // password — surfacing as a confusing "password authentication failed"
    // in one environment but not another with a visually-identical value.
    dbUrl: env['SUPABASE_DB_URL']?.trim(),
    ...(dbCaCert ? { dbCaCert } : {}),
  };
}

function sessionSecret(env: NodeJS.ProcessEnv): string {
  const raw = env['SESSION_SECRET'];
  if (!raw || raw.trim().length < 32) {
    throw new Error(
      '[config] SESSION_SECRET must be set and at least 32 characters long. ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return raw.trim();
}

const SAME_SITE_VALUES = ['lax', 'strict', 'none'] as const;

function sessionSameSite(
  env: NodeJS.ProcessEnv,
  secure: boolean,
): AppConfig['session']['sameSite'] {
  const raw = env['SESSION_COOKIE_SAMESITE']?.trim().toLowerCase();
  if (!raw) {
    return secure ? 'none' : 'lax';
  }
  const sameSite = SAME_SITE_VALUES.find((value) => value === raw);
  if (!sameSite) {
    throw new Error(
      `[config] SESSION_COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(', ')} (got "${raw}").`,
    );
  }
  // Browsers silently drop a SameSite=None cookie that is not Secure, which
  // would surface as "Sign in did not complete" rather than a config error.
  if (sameSite === 'none' && !secure) {
    throw new Error(
      '[config] SESSION_COOKIE_SAMESITE=none requires SESSION_SECURE=true.',
    );
  }
  return sameSite;
}

function sessionConfig(env: NodeJS.ProcessEnv): AppConfig['session'] {
  const cookieDomain = env['SESSION_COOKIE_DOMAIN']?.trim();
  const secure = env['SESSION_SECURE'] === 'true';
  return {
    secret: sessionSecret(env),
    name: env['SESSION_NAME'] ?? 'cicd_workflow_sid',
    maxAgeMs: Number(env['SESSION_MAX_AGE_MS'] ?? 604_800_000),
    secure,
    sameSite: sessionSameSite(env, secure),
    storeDriver:
      env['SESSION_STORE_DRIVER'] === 'postgres' ? 'postgres' : 'memory',
    ...(cookieDomain ? { cookieDomain } : {}),
  };
}

function trustProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = env['TRUST_PROXY_HOPS']?.trim();
  if (!raw) {
    return 1;
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1) {
    throw new Error(
      `[config] TRUST_PROXY_HOPS must be a positive integer (got "${raw}").`,
    );
  }
  return hops;
}

function hierarchyConfig(env: NodeJS.ProcessEnv): AppConfig['hierarchy'] {
  return {
    enabled: env['HIERARCHY_ENABLED'] !== 'false',
    // Defaults to 'stub' regardless of what an unrecognized value is set
    // to — an environment must explicitly set 'live' to enable real
    // GitHub Team API calls (explicit GitHub sync configuration hard requirement: default stub
    // everywhere).
    githubSyncMode:
      env['HIERARCHY_GITHUB_SYNC_MODE'] === 'live' ? 'live' : 'stub',
    encryptionKeyEnvVar:
      env['HIERARCHY_ENCRYPTION_KEY_ENV_VAR'] ??
      'ENV_PROVISIONING_ENCRYPTION_KEY',
    maxSyncRetries: Number(env['HIERARCHY_MAX_SYNC_RETRIES'] ?? 5),
    syncPollIntervalMs: Number(env['HIERARCHY_SYNC_POLL_INTERVAL_MS'] ?? 5000),
  };
}

const DIRECTORY_SOURCES = ['github_org', 'accounts'] as const;

function directoryConfig(
  env: NodeJS.ProcessEnv,
  enforcedOrg: string,
): AppConfig['directory'] {
  const raw = env['MEMBER_DIRECTORY_SOURCE']?.trim().toLowerCase();
  const source = raw
    ? DIRECTORY_SOURCES.find((value) => value === raw)
    : 'github_org';
  // Fail closed: a typo must not silently switch a deployment to a wider
  // directory than the one its operator chose.
  if (!source) {
    throw new Error(
      `[config] MEMBER_DIRECTORY_SOURCE must be one of ${DIRECTORY_SOURCES.join(', ')} (got "${raw ?? ''}").`,
    );
  }
  return {
    source,
    organization: env['MEMBER_DIRECTORY_ORG']?.trim() || enforcedOrg,
  };
}

export const appConfig = registerAs('app', (): AppConfig => {
  const env = process.env;
  const github = githubConfig(env);

  return {
    frontendUrl: env['FRONTEND_URL'] ?? 'http://localhost:3000',
    trustProxyHops: trustProxyHops(env),
    auth: authConfig(env),
    composition: parseCompositionConfig(env),
    github,
    directory: directoryConfig(env, github.enforcedOrg),
    templates: templatesConfig(env),
    subscription: subscriptionConfig(env),
    envProvisioning: provisioningConfig(env),
    gcpDeployments: gcpDeploymentsConfig(env),
    ...featureFlagConfig(env),
    supabase: supabaseConfig(env),
    session: sessionConfig(env),
    archivedAccountRetentionDays: Number(
      env['ARCHIVED_ACCOUNT_RETENTION_DAYS'] ?? 30,
    ),
    hierarchy: hierarchyConfig(env),
  };
});
