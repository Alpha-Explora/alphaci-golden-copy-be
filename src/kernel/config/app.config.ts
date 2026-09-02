import { registerAs } from '@nestjs/config';

import type { SubscriptionPlan } from '#kernel/auth/session-user.interface';

import {
  githubConfig,
  provisioningConfig,
  subscriptionConfig,
} from './app.config-slices';

export { githubConfig, provisioningConfig, subscriptionConfig };

/** See AppConfig['github']['teamRoleSync']. */
export type GithubTeamRoleSyncMode = 'off' | 'seed' | 'enforce';

export interface AppConfig {
  frontendUrl: string;
  github: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    scope: string;
    appId: string;
    appSlug: string;
    appPrivateKey: string;
    appWebhookSecret: string;
    /**
     * Login of the internal company GitHub org. When set, members of this org
     * are stamped is_internal=true on sign-in (and bypass the subscription
     * gate); non-members are hard-blocked on the internal deployment. Leave
     * empty on the external (sold) deployment to disable internal gating.
     */
    internalOrg: string;
    /**
     * ALL repositories created by the product are forced into this GitHub
     * organization instead of the signed-in user's personal account. Requires
     * the GitHub App to be installed on this org with access to all
     * repositories.
     *
     * Empty when GITHUB_ENFORCED_ORG is unset, and deliberately so: there is no
     * default org. A hardcoded fallback would mean a missing or failed config
     * silently routes creation into whichever org the fallback names, which is
     * indistinguishable from success at the call site. Empty instead trips the
     * "no destination org is configured" guard in createRepo(), which names the
     * variable to set. Empty never re-enables personal-account creation — the
     * personal POST /user/repos path does not exist.
     */
    enforcedOrg: string;
    /**
     * How GitHub org team membership feeds identity.app_users.app_role.
     *
     *   'off'     — never read teams (default). Legacy behaviour: app_role is
     *               seeded from org OWNERSHIP on first login only.
     *   'seed'    — team membership seeds app_role on first login only; the
     *               Admin Console owns it from then on.
     *   'enforce' — app_role is re-derived from team membership on every
     *               login (and by the membership webhook), EXCEPT for users
     *               pinned to app_role_source = 'manual'.
     *
     * Mirrors the HIERARCHY_GITHUB_SYNC_MODE safety pattern: an environment
     * must opt in explicitly, and any unrecognized value falls back to 'off'.
     */
    teamRoleSync: GithubTeamRoleSyncMode;
    /** Org team whose members become global 'lead' (may create projects). */
    leadTeamSlug: string;
    /** Org team whose members become global 'member' (assigned work only). */
    developerTeamSlug: string;
    /**
     * How often (ms) the reconciliation sweep re-reads both team rosters and
     * corrects any app_role that drifted — the safety net for webhook
     * deliveries that were missed or arrived while the service was down.
     * 0 disables the sweep. Only runs under teamRoleSync='enforce'.
     */
    teamRoleReconcileIntervalMs: number;
  };
  templates: {
    repoPath: string;
    workflowDir: string;
  };
  subscription: {
    /**
     * When false, every authenticated user is treated as fully entitled and no
     * subscription row is required — the model for contract-billed enterprise
     * deployments. Honoured by SubscriptionService.getForUser and by CI run
     * validation in CiService.
     */
    gateEnabled: boolean;
    mockEnabled: boolean;
    defaultPlan: SubscriptionPlan;
    seededPlans: Record<string, SubscriptionPlan>;
    proMonthlyPricePhp: number;
  };
  envProvisioning: {
    enabled: boolean;
    /**
     * Deployment ownership mode offered by this deployment. BYO ('byo') is
     * archived: every deployment centralizes on the platform's own
     * Render/Vercel/SonarCloud credentials via flowciManaged.*, so the only
     * mode ever offered is 'flowci_managed'. The union type is kept because
     * stored targets and older clients may still carry 'byo' values.
     */
    ownershipMode: 'byo' | 'flowci_managed';
    encryptionKey: string;
    flowciManaged: {
      renderToken: string;
      renderOwnerId: string | null;
      renderDefaultRegion?: string;
      renderDefaultInstanceType?: string;
      renderAllowedInstanceTypes?: string[];
      renderAllowPaidManaged?: boolean;
      renderManagedMaxServicesPerUser?: number;
      // Platform-wide caps on managed targets across ALL users. Because managed
      // mode shares a single Render/Vercel account, per-user quotas alone cannot
      // protect the shared account from aggregate exhaustion. 0 = unlimited.
      renderManagedFleetMax?: number;
      vercelManagedFleetMax?: number;
      renderBootstrapImage?: string;
      renderRegistryCredentialId?: string | null;
      renderRegistryUsername?: string | null;
      renderRegistryToken?: string | null;
      vercelToken: string;
      vercelTeamId: string | null;
      vercelTeamSlug: string | null;
      // Centralized SonarCloud credentials installed into every created repo
      // so the quality-scan job works out of the box.
      sonarToken: string;
      sonarOrganization: string;
    };
  };
  gcpDeployments: {
    enabled: boolean;
    sharedProjectId: string;
    region: string;
    artifactRegistryRepository: string;
    workloadIdentityProvider: string;
    deployerServiceAccount: string;
    dedicatedProjectsEnabled: boolean;
  };
  projectSyncSnapshots: {
    enabled: boolean;
    liveGithubEnabled: boolean;
    liveProvidersEnabled: boolean;
  };
  workflowSettingsPreview: {
    enabled: boolean;
  };
  workflowUpdatePr: {
    enabled: boolean;
  };
  projectTargetManagement: {
    enabled: boolean;
  };
  ciRunTracking: {
    enabled: boolean;
    liveGithubEnabled: boolean;
  };
  deploymentHistory: {
    enabled: boolean;
    liveProvidersEnabled: boolean;
  };
  // Per-branch preview cards. Reads the same provider history as
  // deploymentHistory, so it is only useful with that enabled too.
  previewDeployments: {
    enabled: boolean;
  };
  driftDetection: {
    enabled: boolean;
  };
  driftRepair: {
    enabled: boolean;
    liveRepairEnabled: boolean;
  };
  driftLiveChecks: {
    enabled: boolean;
  };
  usageQuotas: {
    enabled: boolean;
  };
  workspaces: {
    enabled: boolean;
  };
  auditEvents: {
    enabled: boolean;
  };
  notifications: {
    enabled: boolean;
  };
  supabase: {
    dbUrl: string | undefined;
    dbCaCert?: string;
  };
  session: {
    secret: string;
    name: string;
    maxAgeMs: number;
    secure: boolean;
    storeDriver: 'postgres' | 'memory';
    // Optional cookie Domain attribute. Leave UNSET for the current split-domain
    // setup (host-only cookie, today's behavior). When FE + BE move under one
    // parent domain (e.g. app.example.com + api.example.com), set this to
    // ".example.com" so the session cookie is shared first-party across the
    // subdomains — this is what makes login work on Safari/iOS (no third-party
    // cookie). See docs/runbooks/runbook-auth-custom-domain-cutover.md.
    cookieDomain?: string;
  };
  archivedAccountRetentionDays: number;
  hierarchy: {
    enabled: boolean;
    /**
     * 'stub' (default everywhere) runs the full assignment state machine and
     * outbox lifecycle against a no-op GitHub client that always reports
     * success. 'live' switches GithubSyncService's injected
     * GithubTeamAccessProvider to real GitHub Team API calls. See
     * The current hierarchy and GitHub team-access contract require an
     * explicit operator decision before an environment is flipped to 'live'.
     */
    githubSyncMode: 'stub' | 'live';
    encryptionKeyEnvVar: string;
    maxSyncRetries: number;
    syncPollIntervalMs: number;
  };
}

function templatesConfig(env: NodeJS.ProcessEnv): AppConfig['templates'] {
  return {
    repoPath: env['TEMPLATE_REPO_PATH'] ?? '../cicd-workflow',
    workflowDir: env['TEMPLATE_WORKFLOW_DIR'] ?? 'workflow-templates',
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

function featureFlagConfig(env: NodeJS.ProcessEnv): Pick<
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

function sessionConfig(env: NodeJS.ProcessEnv): AppConfig['session'] {
  const cookieDomain = env['SESSION_COOKIE_DOMAIN']?.trim();
  return {
    secret: sessionSecret(env),
    name: env['SESSION_NAME'] ?? 'cicd_workflow_sid',
    maxAgeMs: Number(env['SESSION_MAX_AGE_MS'] ?? 604_800_000),
    secure: env['SESSION_SECURE'] === 'true',
    storeDriver:
      env['SESSION_STORE_DRIVER'] === 'postgres' ? 'postgres' : 'memory',
    ...(cookieDomain ? { cookieDomain } : {}),
  };
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

export const appConfig = registerAs('app', (): AppConfig => {
  const env = process.env;

  return {
    frontendUrl: env['FRONTEND_URL'] ?? 'http://localhost:3000',
    github: githubConfig(env),
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
