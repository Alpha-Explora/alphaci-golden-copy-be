import type { SubscriptionPlan } from '#kernel/auth/session-user.interface';
import type {
  BuildProfile,
  Edition,
} from '#kernel/composition/capability-types';

/** See AppConfig['github']['teamRoleSync']. */
export type GithubTeamRoleSyncMode = 'off' | 'seed' | 'enforce';

export interface AppConfig {
  frontendUrl: string;
  /**
   * TRUST_PROXY_HOPS — how many reverse proxies sit in front of Express. 1 is
   * Render's edge alone. Set 2 while the FE's Vercel rewrite proxies the API,
   * otherwise req.ip is Vercel's egress IP and every user shares one
   * ThrottlerGuard bucket. Each extra hop trusts one more X-Forwarded-For
   * entry, so never set it higher than the real chain.
   */
  trustProxyHops: number;
  auth: {
    /**
     * Enables the local-only development fixture session endpoint. This is
     * derived from DEV_QUICK_LOGIN and NODE_ENV; it is never true in a
     * production or test process.
     */
    devQuickLoginEnabled: boolean;
  };
  composition: {
    edition: Edition;
    profile: BuildProfile;
    client: {
      /** Selected client, or null when the deployment serves the whole edition. */
      id: string | null;
      /** Path to a deployment-supplied client policy document, if mounted. */
      configPath: string | null;
      /** Whether either client-policy selection seam is configured. */
      enabled: boolean;
    };
  };
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
    /**
     * `owner/name` of the central workflow repository that generated pipelines
     * call into. Distinct from the git ref (CENTRAL_WORKFLOW_REF), which selects
     * the tag within it.
     */
    centralWorkflowRepo: string;
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
    // SESSION_COOKIE_SAMESITE. Unset keeps the split-domain default: 'none'
    // when secure (FE and BE on different sites need a cross-site cookie),
    // 'lax' otherwise. Set 'lax' once the browser only ever talks to one site —
    // the FE rewrite proxy or shared subdomains — so the cookie is first-party
    // and no longer rides along on cross-site requests.
    sameSite: 'lax' | 'strict' | 'none';
    // Optional cookie Domain attribute. Leave UNSET for the current split-domain
    // setup (host-only cookie, today's behavior). When FE + BE move under one
    // parent domain (e.g. app.example.com + api.example.com), set this to
    // ".example.com" so the session cookie is shared first-party across the
    // subdomains — this is what makes login work on Safari/iOS (no third-party
    // cookie). See docs/runbooks/runbook-auth-custom-domain-cutover.md.
    cookieDomain?: string;
  };
  archivedAccountRetentionDays: number;
  /**
   * Where this deployment's people come from: the pool a workspace lead picks
   * members from, served by GET /api/v1/directory/members. Deployment
   * configuration, not a client policy (ADR-0011): each client deployment
   * points it at its own organization.
   */
  directory: {
    /**
     * MEMBER_DIRECTORY_SOURCE. 'github_org' (default): members of
     * `organization` on GitHub. 'accounts': every active AlphaCI account on
     * this deployment, for installations with no GitHub organization.
     */
    source: 'github_org' | 'accounts';
    /**
     * MEMBER_DIRECTORY_ORG. The GitHub organization behind 'github_org';
     * defaults to GITHUB_ENFORCED_ORG, the org this deployment already
     * provisions into. Empty leaves the directory unavailable, not open.
     */
    organization: string;
  };
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
