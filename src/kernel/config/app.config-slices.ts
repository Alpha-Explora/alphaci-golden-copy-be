import type { SubscriptionPlan } from '#kernel/auth/session-user.interface';

import type { AppConfig, GithubTeamRoleSyncMode } from './app.config.types';

type Env = NodeJS.ProcessEnv;

/**
 * Any unrecognized value resolves to 'off' — an environment must name the mode
 * exactly to turn GitHub team reads on, matching how HIERARCHY_GITHUB_SYNC_MODE
 * defaults to the inert option.
 */
function resolveTeamRoleSync(raw: string | undefined): GithubTeamRoleSyncMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'seed' || normalized === 'enforce') {
    return normalized;
  }
  return 'off';
}

function githubOAuth(
  env: Env,
): Pick<
  AppConfig['github'],
  'clientId' | 'clientSecret' | 'callbackUrl' | 'scope'
> {
  return {
    clientId: env['GITHUB_CLIENT_ID'] ?? '',
    clientSecret: env['GITHUB_CLIENT_SECRET'] ?? '',
    callbackUrl:
      env['GITHUB_CALLBACK_URL'] ??
      'http://localhost:4000/api/v1/auth/github/callback',
    // read:org is required so the OAuth token can query the signed-in user's
    // org membership (GET /user/memberships/orgs/{org}) for internal gating.
    // delete_repo is required separately from `repo` for the opt-in
    // "delete GitHub repo too" project-delete path (GET /repos DELETE)
    // — GitHub classic OAuth Apps gate repo deletion behind this scope even
    // when `repo` is already granted. Sessions established before this
    // scope was added will keep 403ing on delete until the user
    // reconnects GitHub (see GithubService.deleteRepoForUser).
    scope: env['GITHUB_SCOPE'] ?? 'repo,workflow,read:org,delete_repo',
  };
}

function githubAppCredentials(
  env: Env,
): Pick<
  AppConfig['github'],
  'appId' | 'appSlug' | 'appPrivateKey' | 'appWebhookSecret'
> {
  const isProduction = env['NODE_ENV'] === 'production';
  return {
    // Accept GITHUB_APP_ID with a plain GITHUB_APP alias, and the private key
    // under either GITHUB_APP_PRIVATE_KEY or the shorter GITHUB_PRIVATE_KEY
    // used by the sibling deployment — so a key provisioned under that naming
    // convention still enables the App (hasAppCredentials) here instead of
    // silently falling through to "GitHub App installations are unavailable".
    appId: (env['GITHUB_APP_ID'] ?? env['GITHUB_APP'] ?? '').trim(),
    appSlug:
      env['GITHUB_APP_SLUG']?.trim() || (isProduction ? '' : 'my-github-app'),
    appPrivateKey: (
      env['GITHUB_APP_PRIVATE_KEY'] ??
      env['GITHUB_PRIVATE_KEY'] ??
      ''
    ).replace(/\\n/g, '\n'),
    appWebhookSecret: env['GITHUB_APP_WEBHOOK_SECRET'] ?? '',
  };
}

function githubOrgAndTeams(
  env: Env,
): Pick<
  AppConfig['github'],
  | 'internalOrg'
  | 'enforcedOrg'
  | 'teamRoleSync'
  | 'leadTeamSlug'
  | 'developerTeamSlug'
  | 'teamRoleReconcileIntervalMs'
> {
  const rawEnforcedOrg = env['GITHUB_ENFORCED_ORG']?.trim();
  const resolvedEnforcedOrg =
    rawEnforcedOrg && rawEnforcedOrg in env
      ? env[rawEnforcedOrg]?.trim()
      : rawEnforcedOrg;

  return {
    internalOrg: env['GITHUB_INTERNAL_ORG']?.trim() ?? '',
    // Force every created repository into this org. No default: see the
    // enforcedOrg doc comment on AppConfig for why an unset value resolves to
    // empty and fails loudly rather than picking an org.
    enforcedOrg: resolvedEnforcedOrg ?? '',
    teamRoleSync: resolveTeamRoleSync(env['GITHUB_TEAM_ROLE_SYNC']),
    leadTeamSlug: env['GITHUB_TEAM_LEAD_SLUG']?.trim() || 'team-lead',
    developerTeamSlug:
      env['GITHUB_TEAM_DEVELOPER_SLUG']?.trim() || 'developers',
    teamRoleReconcileIntervalMs: Number(
      env['GITHUB_TEAM_ROLE_RECONCILE_INTERVAL_MS'] ?? 900_000,
    ),
  };
}

export function githubConfig(env: Env): AppConfig['github'] {
  return {
    ...githubOAuth(env),
    ...githubAppCredentials(env),
    ...githubOrgAndTeams(env),
  };
}

export function subscriptionConfig(env: Env): AppConfig['subscription'] {
  const seededPlans: Record<string, SubscriptionPlan> = {};
  try {
    const raw = env['SUBSCRIPTION_MOCK_MAP_JSON'] ?? '{}';
    Object.assign(
      seededPlans,
      JSON.parse(raw) as Record<string, SubscriptionPlan>,
    );
  } catch {
    // malformed JSON — fall through with empty map
  }

  return {
    gateEnabled: env['SUBSCRIPTION_GATE_ENABLED'] !== 'false',
    mockEnabled: env['SUBSCRIPTION_MOCK_ENABLED'] === 'true',
    defaultPlan:
      (env['SUBSCRIPTION_MOCK_DEFAULT_PLAN'] as SubscriptionPlan | undefined) ??
      'free',
    seededPlans,
    proMonthlyPricePhp: Number(env['PRO_MONTHLY_PRICE_PHP'] ?? 300),
  };
}

function dualEnv(env: Env, alphaciKey: string, flowciKey: string): string {
  return env[alphaciKey] ?? env[flowciKey] ?? '';
}

function dualTrim(
  env: Env,
  alphaciKey: string,
  flowciKey: string,
  fallback: string | null,
): string | null {
  return env[alphaciKey]?.trim() || env[flowciKey]?.trim() || fallback;
}

function dualNumber(
  env: Env,
  alphaciKey: string,
  flowciKey: string,
  fallback: string,
): number {
  return Number(env[alphaciKey] ?? env[flowciKey] ?? fallback);
}

function managedRenderCore(
  env: Env,
): Pick<
  AppConfig['envProvisioning']['flowciManaged'],
  | 'renderToken'
  | 'renderOwnerId'
  | 'renderDefaultRegion'
  | 'renderDefaultInstanceType'
  | 'renderAllowedInstanceTypes'
  | 'renderAllowPaidManaged'
> {
  return {
    renderToken: dualEnv(
      env,
      'ALPHACI_RENDER_API_KEY',
      'FLOWCI_RENDER_API_KEY',
    ),
    renderOwnerId: dualTrim(
      env,
      'ALPHACI_RENDER_OWNER_ID',
      'FLOWCI_RENDER_OWNER_ID',
      null,
    ),
    renderDefaultRegion:
      dualTrim(
        env,
        'ALPHACI_RENDER_DEFAULT_REGION',
        'FLOWCI_RENDER_DEFAULT_REGION',
        'singapore',
      ) ?? 'singapore',
    renderDefaultInstanceType:
      dualTrim(
        env,
        'ALPHACI_RENDER_DEFAULT_INSTANCE_TYPE',
        'FLOWCI_RENDER_DEFAULT_INSTANCE_TYPE',
        'free',
      ) ?? 'free',
    renderAllowedInstanceTypes: (
      env['ALPHACI_RENDER_ALLOWED_INSTANCE_TYPES'] ??
      env['FLOWCI_RENDER_ALLOWED_INSTANCE_TYPES'] ??
      'free'
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    renderAllowPaidManaged:
      (env['ALPHACI_RENDER_ALLOW_PAID_MANAGED'] ??
        env['FLOWCI_RENDER_ALLOW_PAID_MANAGED']) === 'true',
  };
}

function managedRenderFleet(
  env: Env,
): Pick<
  AppConfig['envProvisioning']['flowciManaged'],
  | 'renderManagedMaxServicesPerUser'
  | 'renderManagedFleetMax'
  | 'vercelManagedFleetMax'
  | 'renderBootstrapImage'
> {
  return {
    renderManagedMaxServicesPerUser: dualNumber(
      env,
      'ALPHACI_RENDER_MANAGED_MAX_SERVICES_PER_USER',
      'FLOWCI_RENDER_MANAGED_MAX_SERVICES_PER_USER',
      '2',
    ),
    renderManagedFleetMax: dualNumber(
      env,
      'ALPHACI_RENDER_MANAGED_FLEET_MAX',
      'FLOWCI_RENDER_MANAGED_FLEET_MAX',
      '0',
    ),
    vercelManagedFleetMax: dualNumber(
      env,
      'ALPHACI_VERCEL_MANAGED_FLEET_MAX',
      'FLOWCI_VERCEL_MANAGED_FLEET_MAX',
      '0',
    ),
    renderBootstrapImage:
      dualTrim(
        env,
        'ALPHACI_RENDER_BOOTSTRAP_IMAGE',
        'FLOWCI_RENDER_BOOTSTRAP_IMAGE',
        'docker.io/library/nginx:alpine',
      ) ?? 'docker.io/library/nginx:alpine',
  };
}

function managedRenderRegistry(
  env: Env,
): Pick<
  AppConfig['envProvisioning']['flowciManaged'],
  | 'renderRegistryCredentialId'
  | 'renderRegistryUsername'
  | 'renderRegistryToken'
> {
  return {
    renderRegistryCredentialId: dualTrim(
      env,
      'ALPHACI_RENDER_REGISTRY_CREDENTIAL_ID',
      'FLOWCI_RENDER_REGISTRY_CREDENTIAL_ID',
      null,
    ),
    renderRegistryUsername: dualTrim(
      env,
      'ALPHACI_RENDER_REGISTRY_USERNAME',
      'FLOWCI_RENDER_REGISTRY_USERNAME',
      null,
    ),
    renderRegistryToken: dualTrim(
      env,
      'ALPHACI_RENDER_REGISTRY_TOKEN',
      'FLOWCI_RENDER_REGISTRY_TOKEN',
      null,
    ),
  };
}

function managedVercel(
  env: Env,
): Pick<
  AppConfig['envProvisioning']['flowciManaged'],
  'vercelToken' | 'vercelTeamId' | 'vercelTeamSlug'
> {
  return {
    vercelToken: dualEnv(env, 'ALPHACI_VERCEL_TOKEN', 'FLOWCI_VERCEL_TOKEN'),
    vercelTeamId:
      env['ALPHACI_VERCEL_TEAM_ID'] ?? env['FLOWCI_VERCEL_TEAM_ID'] ?? null,
    vercelTeamSlug:
      env['ALPHACI_VERCEL_TEAM_SLUG'] ?? env['FLOWCI_VERCEL_TEAM_SLUG'] ?? null,
  };
}

function managedSonar(
  env: Env,
): Pick<
  AppConfig['envProvisioning']['flowciManaged'],
  'sonarToken' | 'sonarOrganization'
> {
  return {
    sonarToken:
      env['ALPHACI_SONAR_TOKEN']?.trim() ??
      env['FLOWCI_SONAR_TOKEN']?.trim() ??
      '',
    sonarOrganization:
      env['ALPHACI_SONAR_ORGANIZATION']?.trim() ??
      env['FLOWCI_SONAR_ORGANIZATION']?.trim() ??
      '',
  };
}

export function provisioningConfig(env: Env): AppConfig['envProvisioning'] {
  return {
    enabled: env['ENV_PROVISIONING_ENABLED'] === 'true',
    // BYO is archived — the platform always centralizes deployments on its
    // own hosting credentials, so ENV_PROVISIONING_OWNERSHIP_MODE is
    // intentionally ignored.
    ownershipMode: 'flowci_managed',
    encryptionKey: env['ENV_PROVISIONING_ENCRYPTION_KEY'] ?? '',
    flowciManaged: {
      ...managedRenderCore(env),
      ...managedRenderFleet(env),
      ...managedRenderRegistry(env),
      ...managedVercel(env),
      ...managedSonar(env),
    },
  };
}
