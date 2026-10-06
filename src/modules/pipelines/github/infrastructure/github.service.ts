import { createSign } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  BadGatewayException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sodium from 'libsodium-wrappers';

import type { AppConfig } from '#kernel/config/app.config';
import {
  GithubRepoDeleteError,
  type GitHubBranchComparison,
  type GitHubCommitAuthor,
  type GitHubJobLogResult,
  type GitHubDispatchWorkflowResult,
  type GitHubCommitFilesInput,
  type GitHubCommitFilesResult,
  type GitHubRepoFilesResult,
  type GitHubOpenPullRequestInput,
  type GitHubOpenPullRequestResult,
  type GithubOrganizationMember,
  type GithubOrganizationPort,
  type GitHubCommitListQuery,
  type GitHubCommitPage,
  type GithubBranchProtectionOutcome,
  type GithubBranchProtectionSummary,
  type GithubPullRequestProtectionOptions,
  type GitHubPullRequestHeadline,
  type GitHubPushCommits,
  type GitHubRepositoryEventsResult,
  type GithubProjectPort,
  type GithubRepositoryDeletedEvent,
  type GithubTeamMembershipChangedEvent,
} from '#kernel/ports/github.port';
export { GithubRepoDeleteError } from '#kernel/ports/github.port';
export type { GithubRepoDeleteErrorCode } from '#kernel/ports/github.port';
import type { CreateRepoDto } from '../api/dto/create-repo.dto';
import { GithubActivityClient } from './github-activity.client';
import { GithubRepoFilesClient } from './github-repo-files.client';
import { ensurePullRequestProtection } from './github-branch-protection';
import { GithubHttp } from './github-http';
import { GithubInstallationLinker } from './github-installation-linker';
import {
  GithubInstallationsRepository,
  type GithubInstallation,
  type GithubInstallationRepo,
} from './github-installations.repository';
import {
  GithubWebhookProcessor,
  REPOSITORY_DELETED_EVENT,
  TEAM_MEMBERSHIP_CHANGED_EVENT,
} from './github-webhook.processor';
import {
  encodeRef,
  mapContentEntries,
  toBranchComparison,
  ACTIONS_APP_SLUG,
  indexWorkflowRunsByCheckSuite,
  isFailedCheck,
  MAX_ANNOTATED_CHECKS,
  toCheckRunCheck,
  toCodeAnnotations,
  toStatusCheck,
  toFileListing,
  toPullRequestDetail,
  toPullRequestFile,
  toPullRequestSummary,
  type GitHubCompareRow,
  type GitHubContentsRow,
  type GitHubAnnotationRow,
  type GitHubCheckRunRow,
  type GitHubCommitStatusRow,
  type GitHubCheckSuiteRunRow,
  type CheckWorkflowInfo,
  type GitHubPullRequestFileRow,
  type GitHubPullRequestRow,
  userWriteRefusal,
  validationMessage,
} from './github-workspace.mapping';
import type {
  GitHubBranchSummary,
  GitHubContentListing,
  GitHubMergeResult,
  GitHubPullRequestCheck,
  GitHubPullRequestDetail,
  GitHubPullRequestFile,
  GitHubPullRequestSummary,
  GitHubRunJob,
  GitHubWorkflowRunSummary,
} from './github-workspace.types';

export {
  REPOSITORY_DELETED_EVENT,
  TEAM_MEMBERSHIP_CHANGED_EVENT,
  type RepositoryDeletedEvent,
  type TeamMembershipChangedEvent,
} from './github-webhook.processor';

interface GitHubRepoResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  updated_at: string;
}

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
  sha?: string;
}

/**
 * Raw rows from GitHub's REST responses, declared only as far as the workspace
 * reads consume them. Every field is optional: these describe someone else's
 * API, and a missing key must fall back rather than throw.
 */
interface GitHubWorkflowRunRow {
  id: number;
  name?: string;
  display_title?: string;
  head_branch?: string;
  head_sha?: string;
  head_commit?: { message?: string };
  event?: string;
  status?: string;
  conclusion?: string | null;
  run_number?: number;
  run_attempt?: number;
  html_url?: string;
  actor?: { login?: string };
  created_at?: string;
  updated_at?: string;
}

interface GitHubRunJobRow {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  steps?: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    number?: number;
    started_at?: string | null;
    completed_at?: string | null;
  }>;
}

interface GitHubContentsWriteResponse {
  content?: { html_url?: string };
  commit?: { sha?: string; html_url?: string };
}

interface GitHubPullRequestResponse {
  number?: number;
  html_url?: string;
}

export type { GitHubRepo } from '#kernel/ports/github.port';
import type { GitHubRepo } from '#kernel/ports/github.port';

/*
 * There is deliberately no DEFAULT_ENFORCED_ORG.
 *
 * A hardcoded fallback used to live here, mirroring app.config.ts, so that a
 * ConfigService failure could not leave getEnforcedOrg() empty. That reasoning
 * holds only while the fallback names the org you actually want: it converts a
 * config failure into a silent write to whichever org is hardcoded, reported to
 * the caller as success. Once a deployment points GITHUB_ENFORCED_ORG at a
 * sandbox, the same fallback routes creation back into the production org at
 * precisely the moment configuration is least trustworthy.
 *
 * Empty is the safer failure. createRepo()'s guard turns it into a 403 naming
 * the variable to set, and every other org-scoped call here already returns
 * empty rather than requesting `orgs//...`. Nothing about an empty org
 * re-enables personal-account creation — the POST /user/repos path was removed.
 */

@Injectable()
export class GithubService
  extends EventEmitter
  implements GithubProjectPort, GithubOrganizationPort
{
  private readonly logger = new Logger(GithubService.name);
  private readonly appId: string;
  private readonly appSlug: string;
  private readonly appPrivateKey: string;
  private readonly appWebhookSecret: string;
  private readonly http: GithubHttp;
  private readonly activity: GithubActivityClient;
  private readonly repoFiles: GithubRepoFilesClient;
  private readonly installationLinker: GithubInstallationLinker;
  private readonly webhookProcessor: GithubWebhookProcessor;

  // Explicit @Inject tokens are required here: the `| null` union types make
  // emitDecoratorMetadata serialize these params as `Object`, so token-less
  // injection silently resolves to undefined (with @Optional) or fails. The
  // `| null` in the type exists only so unit tests can construct the service
  // without a Nest container; at runtime both dependencies must resolve.
  constructor(
    @Inject(ConfigService)
    private readonly configService: ConfigService | null,
    @Inject(GithubInstallationsRepository)
    private readonly githubInstallationsRepository: GithubInstallationsRepository | null,
  ) {
    super();
    const config = this.configService?.get<AppConfig>('app');
    this.appId = config?.github.appId ?? '';
    this.appSlug = config?.github.appSlug?.trim() ?? '';
    this.appPrivateKey = config?.github.appPrivateKey ?? '';
    this.appWebhookSecret = config?.github.appWebhookSecret ?? '';

    // Printed once per process boot so a stale deploy (running code that
    // predates the enforced-org fallback, or a config wiring regression) is
    // visible in the Render log stream immediately — instead of only
    // surfacing when a user hits create-project and gets a 403.
    const enforcedOrg = config?.github.enforcedOrg?.trim();
    this.logger.log(
      enforcedOrg
        ? `Repository creation is enforced to organization: ${enforcedOrg}`
        : 'GITHUB ENFORCED ORG RESOLVED EMPTY AT BOOT — repository creation will be refused. Check that this deploy includes the enforced-org config fallback.',
    );

    this.http = new GithubHttp(this.logger);
    this.activity = new GithubActivityClient(this.http);
    this.repoFiles = new GithubRepoFilesClient(this.http);
    this.installationLinker = new GithubInstallationLinker({
      logger: this.logger,
      http: this.http,
      installations: this.githubInstallationsRepository,
      createAppJwt: () => this.createAppJwt(),
      createInstallationAccessToken: (id) =>
        this.createInstallationAccessToken(id),
    });

    this.webhookProcessor = new GithubWebhookProcessor({
      getWebhookSecret: () =>
        this.configService?.get<AppConfig>('app')?.github.appWebhookSecret ??
        this.appWebhookSecret,
      installations: this.githubInstallationsRepository,
      tokens: {
        createInstallationAccessToken: (id) =>
          this.createInstallationAccessToken(id),
        fetchInstallationRepositories: (token) =>
          this.fetchInstallationRepositories(token),
      },
      emit: (event, payload) => this.emit(event, payload),
    });
  }

  getAppInstallUrl(): string {
    const appSlug = this.getAppSlug();
    if (!appSlug) {
      throw new InternalServerErrorException(
        'GitHub App installation is not configured. Set GITHUB_APP_SLUG and restart the service.',
      );
    }
    return `https://github.com/apps/${appSlug}/installations/new`;
  }

  getAppSlug(): string {
    return (
      this.configService?.get<AppConfig>('app')?.github.appSlug?.trim() ??
      this.appSlug
    );
  }

  /**
   * Login of the org that every created repository must belong to.
   *
   * Empty when GITHUB_ENFORCED_ORG is unset, or when ConfigService is null or
   * the `app` namespace failed to load. Callers must treat empty as "no
   * destination configured" and refuse rather than substituting one; see the
   * note above on why no fallback org is hardcoded here.
   */
  getEnforcedOrg(): string {
    return (
      this.configService?.get<AppConfig>('app')?.github.enforcedOrg?.trim() ??
      ''
    );
  }

  onRepositoryDeleted(
    listener: (event: GithubRepositoryDeletedEvent) => void,
  ): void {
    this.on(REPOSITORY_DELETED_EVENT, listener);
  }

  onTeamMembershipChanged(
    listener: (event: GithubTeamMembershipChangedEvent) => void,
  ): void {
    this.on(TEAM_MEMBERSHIP_CHANGED_EVENT, listener);
  }

  /**
   * Every member of `org`, read with the first credential GitHub accepts.
   *
   * The caller's own OAuth token comes first because it is the one credential
   * every deployment has: login requests read:org, and a workspace lead is an
   * org member. An App installation needs a recorded install, which a fresh or
   * rebuilt database does not have, and relying on it alone left the member
   * picker empty for every user. The installations remain as fallbacks for
   * callers whose session carries no token.
   *
   * Null when nothing could read the roster. A refused credential hands over
   * to the next; only a roster that was actually read is returned.
   */
  async readOrganizationMembers(input: {
    org: string;
    userId: string;
    userToken: string | null;
  }): Promise<GithubOrganizationMember[] | null> {
    const org = input.org.trim();
    if (!org) return null;

    const credentials: Array<{
      label: string;
      token: () => Promise<string | null>;
    }> = [
      { label: 'user token', token: () => Promise.resolve(input.userToken) },
      {
        label: "user's App installation",
        token: () => this.getInstallationAccessTokenForUser(input.userId),
      },
      {
        label: "org's App installation",
        token: () => this.getOrganizationInstallationToken(org),
      },
    ];

    for (const credential of credentials) {
      const token = await credential.token();
      if (!token) continue;
      const members = await this.fetchOrganizationMembers(org, token);
      if (members) return members;
      this.logger.warn(
        `Organization ${org} roster unreadable with the ${credential.label}; trying the next credential.`,
      );
    }
    return null;
  }

  private async getOrganizationInstallationToken(
    org: string,
  ): Promise<string | null> {
    if (!this.githubInstallationsRepository) return null;
    try {
      const installationId =
        await this.githubInstallationsRepository.findInstallationIdByAccountLogin(
          org,
        );
      return installationId === null
        ? null
        : await this.createInstallationAccessToken(installationId);
    } catch (error) {
      this.logger.warn(
        `Could not mint an installation token for org ${org}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Null when GitHub refuses the token for this roster, on any page. */
  private async fetchOrganizationMembers(
    org: string,
    token: string,
  ): Promise<GithubOrganizationMember[] | null> {
    const members: GithubOrganizationMember[] = [];
    const maxPages = 5; // caps the roster at 500 members per request
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.http.fetchWithRetry(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/members?per_page=100&page=${String(page)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );
      if (!response.ok) {
        this.logger.warn(
          `Listing members of org ${org} returned ${String(response.status)}. A user token needs read:org and the org's approval of this OAuth app; an installation needs org Members:Read.`,
        );
        return null;
      }
      const batch = (await response.json()) as Array<{
        login: string;
        avatar_url?: string | null;
      }>;
      for (const item of batch) {
        members.push({ login: item.login, avatarUrl: item.avatar_url ?? null });
      }
      if (batch.length < 100) break;
    }
    return members;
  }

  /**
   * Whether `login` is an active member of `teamSlug` in the enforced org.
   *
   * Uses GET /orgs/{org}/teams/{team_slug}/memberships/{username}, which needs
   * either an App installation token with org `Members: Read` or a user token
   * carrying `read:org` (already in GITHUB_SCOPE).
   *
   *   200 + state 'active'  → true   (a 'pending' invite is NOT membership)
   *   404                   → false  (not a member, or team does not exist)
   *   anything else         → null   ("unknown" — the caller must NOT treat
   *                                   this as "not a member", or a transient
   *                                   403/5xx would silently demote people)
   *
   * The null-vs-false distinction is the whole safety story for role sync.
   */
  async getTeamMembership(
    teamSlug: string,
    login: string,
    token: string,
  ): Promise<boolean | null> {
    const org = this.getEnforcedOrg();
    if (!org || !teamSlug || !login) return null;

    try {
      const response = await this.http.fetchWithRetry(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(login)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (response.status === 404) return false;
      if (!response.ok) {
        this.logger.warn(
          `Team membership check for ${login} in ${org}/${teamSlug} returned ${String(response.status)} — treating as unknown. Check the App has org Members:Read.`,
        );
        return null;
      }

      const payload = (await response.json()) as { state?: string };
      return payload.state === 'active';
    } catch (error) {
      this.logger.warn(
        `Team membership check for ${login} in ${org}/${teamSlug} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Every active member login of `teamSlug` in the enforced org, using the
   * acting user's installation token. Returns [] when no token is available or
   * the read fails, the graceful-degradation
   * contract — callers reconciling roles must treat [] as "could not read"
   * rather than "the team is empty".
   */
  async listTeamMembers(userId: string, teamSlug: string): Promise<string[]> {
    const token = await this.getInstallationAccessTokenForUser(userId);
    if (!token) return [];
    return this.listTeamMembersWithToken(teamSlug, token);
  }

  /**
   * Roster variant for callers that already hold a token — notably background
   * jobs, which have no acting user to resolve an installation token from.
   */
  async listTeamMembersWithToken(
    teamSlug: string,
    token: string,
  ): Promise<string[]> {
    const org = this.getEnforcedOrg();
    if (!org || !teamSlug || !token) return [];

    const logins: string[] = [];
    const maxPages = 5; // cap at 500 members, same bound as the org roster
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.http.fetchWithRetry(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/members?per_page=100&page=${String(page)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );
      if (!response.ok) {
        this.logger.warn(
          `Could not list members of team ${org}/${teamSlug} (${String(response.status)}) — check the App has org Members:Read`,
        );
        break;
      }
      const batch = (await response.json()) as Array<{ login: string }>;
      for (const item of batch) logins.push(item.login);
      if (batch.length < 100) break;
    }
    return logins;
  }

  createAppJwt(nowSeconds = Math.floor(Date.now() / 1000)): string {
    const githubConfig = this.configService?.get<AppConfig>('app')?.github;
    const appId = githubConfig?.appId ?? this.appId;
    const appPrivateKey = githubConfig?.appPrivateKey ?? this.appPrivateKey;

    if (!appId || !appPrivateKey) {
      throw new UnprocessableEntityException(
        'GitHub App credentials are not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.',
      );
    }

    const header = this.base64UrlJson({ alg: 'RS256', typ: 'JWT' });
    const payload = this.base64UrlJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: appId,
    });
    const unsigned = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(appPrivateKey, 'base64url');

    return `${unsigned}.${signature}`;
  }

  async createInstallationAccessToken(installationId: number): Promise<string> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/app/installations/${String(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.createAppJwt()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub installation token request failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as { token?: string };
    if (!payload.token) {
      throw new BadGatewayException(
        'GitHub installation token response did not include a token',
      );
    }

    return payload.token;
  }

  async getInstallationAccessTokenForUser(
    userId: string,
  ): Promise<string | null> {
    if (!this.githubInstallationsRepository) return null;

    const installations =
      await this.githubInstallationsRepository.findByUserId(userId);
    const installation =
      installations.find((item) => item.repositorySelection === 'all') ??
      installations[0];

    if (!installation) return null;

    try {
      return await this.createInstallationAccessToken(
        installation.installationId,
      );
    } catch (error) {
      this.logger.warn(
        `Could not create installation token for user ${userId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async getInstallationAccessTokenForUserRepo(
    userId: string,
    repoFullName: string,
  ): Promise<string | null> {
    if (!this.githubInstallationsRepository) return null;

    const [owner] = repoFullName.split('/');
    if (!owner) return null;

    const installations =
      await this.githubInstallationsRepository.findByUserId(userId);
    if (installations.length === 0) return null;

    const linkedRepos =
      await this.githubInstallationsRepository.findReposByUserId(userId);
    const normalizedRepoFullName = repoFullName.toLowerCase();
    const normalizedOwner = owner.toLowerCase();

    const selectedRepoInstallationId = linkedRepos.find(
      (repo) => repo.repoFullName.toLowerCase() === normalizedRepoFullName,
    )?.installationId;

    const installation =
      (selectedRepoInstallationId
        ? installations.find(
            (item) => item.installationId === selectedRepoInstallationId,
          )
        : undefined) ??
      installations.find(
        (item) =>
          item.repositorySelection === 'all' &&
          item.accountLogin?.toLowerCase() === normalizedOwner,
      );

    if (!installation) return null;

    try {
      return await this.createInstallationAccessToken(
        installation.installationId,
      );
    } catch (error) {
      this.logger.warn(
        `Could not create installation token for ${repoFullName} and user ${userId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async linkInstallation(
    userId: string,
    installationId: number,
  ): Promise<{ reposLinked: number; repositorySelection: 'all' | 'selected' }> {
    return this.installationLinker.linkInstallation(userId, installationId);
  }

  /**
   * The HTTP entry point (POST /github/installations). Verifies the user's own
   * OAuth token can access the installation before linking anything; internal
   * re-links of installations this user already owns keep calling
   * linkInstallation directly.
   */
  async linkInstallationForUser(
    userId: string,
    installationId: number,
    githubAccessToken: string | null | undefined,
  ): Promise<{ reposLinked: number; repositorySelection: 'all' | 'selected' }> {
    await this.installationLinker.assertInstallationAccessibleToUser(
      installationId,
      githubAccessToken,
    );
    return this.installationLinker.linkInstallation(userId, installationId);
  }

  async listLinkedRepos(userId: string): Promise<GithubInstallationRepo[]> {
    if (!this.githubInstallationsRepository) return [];
    try {
      return await this.githubInstallationsRepository.findReposByUserId(userId);
    } catch (error) {
      this.logger.warn(
        `Could not fetch linked repos for user ${userId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  async listInstallationAccounts(
    userId: string,
  ): Promise<GithubInstallation[]> {
    if (!this.githubInstallationsRepository) return [];
    try {
      let installations =
        await this.githubInstallationsRepository.findByUserId(userId);
      const missingAccountType = installations.filter(
        (installation) => !installation.accountType,
      );
      if (missingAccountType.length > 0) {
        await Promise.all(
          missingAccountType.map((installation) =>
            this.linkInstallation(userId, installation.installationId),
          ),
        );
        installations =
          await this.githubInstallationsRepository.findByUserId(userId);
      }
      return installations;
    } catch (error) {
      this.logger.warn(
        `Could not fetch installations for user ${userId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  async handleWebhook(
    signature: string | undefined,
    eventName: string | undefined,
    deliveryId: string | undefined,
    rawBody: Buffer | undefined,
    payload: unknown,
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    return this.webhookProcessor.handleWebhook(
      signature,
      eventName,
      deliveryId,
      rawBody,
      payload,
    );
  }

  /**
   * Returns the account login of the first GitHub App installation linked to
   * the given user, or undefined when no installation is linked.
   */
  async getInstallationOwnerLogin(userId: string): Promise<string | undefined> {
    if (!this.githubInstallationsRepository) return undefined;
    const installations =
      await this.githubInstallationsRepository.findByUserId(userId);
    const installation =
      installations.find((item) => item.repositorySelection === 'all') ??
      installations[0];
    return installation?.accountLogin ?? undefined;
  }

  async getOrganizationProvisioningContext(
    userId: string,
    installationId: number,
  ): Promise<{ accessToken: string; ownerLogin: string }> {
    if (!this.githubInstallationsRepository) {
      throw new ServiceUnavailableException(
        'GitHub App installation records cannot be read: the database layer is not initialized on this deployment.',
      );
    }

    let installation =
      await this.githubInstallationsRepository.findByUserIdAndInstallationId(
        userId,
        installationId,
      );

    if (!installation) {
      throw new ForbiddenException(
        'The selected GitHub App installation is not linked to this account.',
      );
    }

    if (!installation.accountType) {
      await this.linkInstallation(userId, installationId);
      installation =
        await this.githubInstallationsRepository.findByUserIdAndInstallationId(
          userId,
          installationId,
        );
    }

    if (installation?.accountType !== 'Organization') {
      throw new ForbiddenException(
        'The selected GitHub App installation does not belong to an organization.',
      );
    }
    if (installation.repositorySelection !== 'all') {
      throw new ForbiddenException(
        'Organization repository creation requires GitHub App access to all repositories.',
      );
    }
    if (!installation.accountLogin) {
      throw new ForbiddenException(
        'The selected GitHub App installation has no organization login.',
      );
    }

    return {
      accessToken: await this.createInstallationAccessToken(installationId),
      ownerLogin: installation.accountLogin,
    };
  }

  /** True when GitHub App credentials (App ID + private key) are configured. */
  private hasAppCredentials(): boolean {
    const github = this.configService?.get<AppConfig>('app')?.github;
    return Boolean(
      (github?.appId ?? this.appId) &&
      (github?.appPrivateKey ?? this.appPrivateKey),
    );
  }

  /**
   * Resolve the GitHub App installation for an org directly via the App JWT
   * (GET /orgs/{org}/installation). Requires no per-user linkage — the App is
   * installed once on the org and every request resolves it centrally.
   */
  private async getInstallationForOrg(orgLogin: string): Promise<{
    id: number;
    accountLogin: string;
    targetType: string;
    repositorySelection: string;
  }> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/installation`,
      {
        headers: {
          Authorization: `Bearer ${this.createAppJwt()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 404) {
      const appSlug = this.getAppSlug();
      throw new ForbiddenException(
        `The GitHub App is not installed on the ${orgLogin} organization. ` +
          (appSlug
            ? `Install it at https://github.com/apps/${appSlug}/installations/new, ` +
              `choose the ${orgLogin} organization, and grant access to all repositories, then try again.`
            : `Install it on ${orgLogin} with access to all repositories, then try again.`),
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub org installation lookup failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as {
      id: number;
      account?: { login?: string };
      target_type?: string;
      repository_selection?: string;
    };

    return {
      id: payload.id,
      accountLogin: payload.account?.login ?? orgLogin,
      targetType: payload.target_type ?? '',
      repositorySelection: payload.repository_selection ?? '',
    };
  }

  /**
   * Resolve the org provisioning context for a fixed org login (used when the
   * deployment enforces a single destination org, e.g. Alpha-Explora).
   *
   * The GitHub App is installed once on the enforced org, so the installation
   * is always resolved app-to-org via the App JWT — no per-user linkage is
   * consulted. Every failure names its exact cause: missing server credentials,
   * App not installed on the org, or insufficient repository access.
   */
  async getOrganizationProvisioningContextByLogin(
    orgLogin: string,
  ): Promise<{ accessToken: string; ownerLogin: string }> {
    if (!this.hasAppCredentials()) {
      throw new ServiceUnavailableException(
        `Repository creation in the ${orgLogin} organization is not available: ` +
          'this deployment has no GitHub App credentials. Set GITHUB_APP_ID and ' +
          'GITHUB_APP_PRIVATE_KEY (or GITHUB_APP / GITHUB_PRIVATE_KEY) and restart the service.',
      );
    }

    const installation = await this.getInstallationForOrg(orgLogin);

    if (installation.targetType !== 'Organization') {
      throw new ForbiddenException(
        `The GitHub App installation for ${orgLogin} is not an organization installation.`,
      );
    }
    if (installation.repositorySelection !== 'all') {
      throw new ForbiddenException(
        `The GitHub App is installed on ${orgLogin} with "${installation.repositorySelection}" ` +
          'repository access, but creating repositories requires "All repositories". ' +
          `Update it on GitHub: ${orgLogin} organization Settings -> GitHub Apps -> ` +
          `${this.getAppSlug() || 'the app'} -> Configure -> Repository access -> All repositories.`,
      );
    }

    return {
      accessToken: await this.createInstallationAccessToken(installation.id),
      ownerLogin: installation.accountLogin,
    };
  }

  /**
   * Returns true if the repository exists and the token has access to it.
   * Returns false only on 404 (deleted or never existed).
   * Throws on 401/403 and other unexpected statuses (5xx, network errors) —
   * those don't confirm the repo is gone, they mean the check itself is
   * unreliable (bad/revoked token, secondary rate limit, transient outage).
   * Callers must not treat a thrown error as "not found".
   */
  async repoExists(
    accessToken: string,
    repoFullName: string,
  ): Promise<boolean> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 200) return true;
    // 404 alone confirms GitHub does not have this repo. 401/403 are
    // ambiguous — they can mean the token was revoked, the repo's visibility
    // changed, or GitHub's secondary rate limit kicked in — none of which
    // mean the repo is actually gone. Treating them as "not found" would
    // mass-orphan every project checked with the same bad token in one sync
    // pass, so they fall through to the throw below instead, which callers
    // (syncProjects) already treat as a skippable, non-conclusive check.
    if (response.status === 404) return false;

    const body = await response.text();
    throw new BadGatewayException(
      `GitHub repo existence check failed (${String(response.status)}): ${body}`,
    );
  }

  async listRepos(accessToken: string): Promise<GitHubRepo[]> {
    const response = await this.http.fetchWithRetry(
      'https://api.github.com/user/repos?per_page=100&sort=updated&type=all',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as GitHubRepoResponse[];
    return payload.map((repo) => this.toRepo(repo));
  }

  async getRepo(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepo> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub repo lookup failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as GitHubRepoResponse;
    return this.toRepo(payload);
  }

  private toRepo(repo: GitHubRepoResponse): GitHubRepo {
    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      description: repo.description,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      updatedAt: repo.updated_at,
    };
  }

  async createRepo(
    accessToken: string,
    dto: CreateRepoDto,
    ownerLogin?: string,
  ): Promise<{
    repoUrl: string;
    cloneUrl: string;
    ownerLogin: string;
    repoName: string;
  }> {
    // Repositories are ALWAYS created inside a GitHub organization. The personal
    // `POST /user/repos` path has been removed entirely so a repository can never
    // be provisioned into a user's own account — not through a missing owner, and
    // not through configuration. `getEnforcedOrg()` is empty when no
    // GITHUB_ENFORCED_ORG is set, and the guard below is how that surfaces.
    const targetOwner = ownerLogin || this.getEnforcedOrg();
    if (!targetOwner) {
      throw new ForbiddenException(
        'Repository creation is locked to a GitHub organization, but no ' +
          'destination org is configured. Set GITHUB_ENFORCED_ORG to a valid ' +
          'organization login.',
      );
    }

    return this.createRepoForOrg(accessToken, dto, targetOwner);
  }

  private async createRepoForOrg(
    accessToken: string,
    dto: CreateRepoDto,
    orgLogin: string,
  ): Promise<{
    repoUrl: string;
    cloneUrl: string;
    ownerLogin: string;
    repoName: string;
  }> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/orgs/${orgLogin}/repos`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: dto.repoName,
          description: dto.description ?? '',
          private: dto.private,
          auto_init: true,
          default_branch: 'main',
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401 || response.status === 403) {
        // GitHub says exactly why here — "OAuth App access restrictions",
        // "Resource not accessible by integration", "must be a member" — and
        // dropping it left only generic advice that sent people to check
        // things that were already correct. The 422 and 5xx branches below
        // always included the body; this one is why a 403 took an
        // investigation to read.
        throw new ForbiddenException(
          `GitHub denied repository creation in organization ${orgLogin} (${String(response.status)}): ${body}`,
        );
      }
      if (response.status === 404) {
        throw new ForbiddenException(
          `GitHub organization ${orgLogin} is unavailable to the signed-in user or OAuth token. Sign out and sign back in with GitHub, then confirm the user belongs to the organization.`,
        );
      }
      if (response.status === 422) {
        throw new UnprocessableEntityException(
          `Repository already exists in ${orgLogin} or the name is invalid: ${body}`,
        );
      }
      throw new BadGatewayException(
        `GitHub repo creation failed (${String(response.status)}): ${body}`,
      );
    }

    const repo = (await response.json()) as {
      html_url: string;
      clone_url: string;
      owner: { login: string };
      name: string;
    };

    return {
      repoUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      ownerLogin: repo.owner.login,
      repoName: repo.name,
    };
  }

  /**
   * Best-effort repository deletion, used to compensate a provisioning failure
   * so a half-created repo is not left orphaned (which would 422 on retry).
   * Never throws: deletion requires the `delete_repo` OAuth scope, which may be
   * absent — failures are logged and swallowed so they cannot mask the original
   * provisioning error. Returns true only when GitHub confirmed the deletion.
   */
  async deleteRepo(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<boolean> {
    try {
      const response = await this.http.fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (response.status === 204) {
        return true;
      }

      this.logger.warn(
        `Compensating repo delete for ${owner}/${repo} returned ${String(response.status)}; manual cleanup may be required`,
      );
      return false;
    } catch (error) {
      this.logger.warn(
        `Compensating repo delete for ${owner}/${repo} failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * User-initiated repository deletion (project delete's opt-in "also delete
   * the GitHub repo" path). Unlike deleteRepo() above — a silent best-effort
   * compensating action that other call sites depend on staying silent —
   * this throws a typed GithubRepoDeleteError on any non-success response so
   * the caller can show the user *why* it failed, most importantly
   * distinguishing a missing `delete_repo` OAuth scope (session token was
   * issued before that scope was added; user must reconnect GitHub) from a
   * repo that's already gone or some other API error.
   */
  async deleteRepoForUser(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<void> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 204) {
      return;
    }

    if (response.status === 404) {
      throw new GithubRepoDeleteError(
        'not_found',
        `GitHub could not find ${owner}/${repo}. If it is already deleted, untick "also delete on GitHub" to disconnect the project on its own.`,
      );
    }

    if (response.status === 401) {
      throw new GithubRepoDeleteError(
        'token_rejected',
        `GitHub rejected this session's token, so ${owner}/${repo} was not deleted. Sign out and sign back in, then try again.`,
      );
    }

    if (response.status === 403) {
      throw await this.explainRepoDeleteRefusal(response, owner, repo);
    }

    const body = await response.text().catch(() => '');
    const summary = body ? ` ${body.slice(0, 300)}` : '';
    throw new GithubRepoDeleteError(
      'other',
      `GitHub repo deletion failed (${String(response.status)}):${summary}`,
    );
  }

  /**
   * Why GitHub answered 403 to a repository delete, as far as it said.
   *
   * This used to be one canned sentence blaming a missing `delete_repo` scope.
   * Two real deletions got it while the login requested that scope and the
   * user was an organisation admin, so the advice - reconnect your account -
   * could not have helped. The response carries better evidence, and it is
   * read in order of how directly it answers:
   *
   *   1. GitHub's own words. An organisation with OAuth app access
   *      restrictions names them in the body. It is matched, never echoed:
   *      the message that reaches the user is still written here.
   *   2. The token's granted scopes. GitHub returns X-OAuth-Scopes for OAuth
   *      tokens, so a missing `delete_repo` is a fact, not an inference.
   *   3. Neither. Then the cause is not established, and the message lists
   *      what it usually is instead of choosing one.
   */
  private async explainRepoDeleteRefusal(
    response: Response,
    owner: string,
    repo: string,
  ): Promise<GithubRepoDeleteError> {
    const body = await response.text().catch(() => '');
    if (/OAuth App access restrictions/i.test(body)) {
      return new GithubRepoDeleteError(
        'org_restricted',
        `The ${owner} organization restricts which apps can act on its repositories, and ALPHACI is not approved, so ${owner}/${repo} was not deleted. An organization owner can approve it under Settings → Third-party application access policy.`,
      );
    }

    // Absent for GitHub App and fine-grained tokens, and in some test doubles,
    // so a missing header means "unknown", never "no delete_repo".
    const grantedScopes = response.headers?.get('x-oauth-scopes') ?? null;
    if (grantedScopes !== null) {
      const scopes = grantedScopes
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      if (!scopes.includes('delete_repo')) {
        return new GithubRepoDeleteError(
          'missing_scope',
          `This session's GitHub token does not include permission to delete repositories, so ${owner}/${repo} was not deleted. Sign out and sign back in to grant it.`,
        );
      }
    }

    const scopeNote =
      grantedScopes === null
        ? ''
        : ' even though the token can delete repositories';
    return new GithubRepoDeleteError(
      'forbidden',
      `GitHub refused to delete ${owner}/${repo}${scopeNote}. Deleting a repository needs admin rights on it, and the organization must allow its members to delete repositories.`,
    );
  }

  /**
   * Names of the Actions secrets already configured on a repository.
   *
   * Values are never returned by GitHub — only names — which is exactly what
   * onboarding needs: enough to know NOT to overwrite a secret somebody else
   * set, without ever reading it. Returns an empty set rather than throwing
   * when the token cannot list secrets, so a missing permission degrades to
   * "assume nothing exists" and the caller's own strict write still reports
   * the real error.
   */
  /**
   * Removes one Actions secret.
   *
   * Used to undo a failed onboarding. A 404 counts as success — the goal is
   * "this secret is not there", and it already isn't.
   */
  async deleteActionsSecret(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
  ): Promise<void> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(secretName)}`,
      { method: 'DELETE', headers: this.http.workspaceHeaders(accessToken) },
    );

    if (!response.ok && response.status !== 404) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub secret delete failed (${String(response.status)}): ${body.slice(0, 200)}`,
      );
    }
  }

  async listActionsSecretNames(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<Set<string>> {
    try {
      const response = await this.http.fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/actions/secrets?per_page=100`,
        { headers: this.http.workspaceHeaders(accessToken) },
      );

      if (!response.ok) return new Set();

      const payload = (await response.json()) as {
        secrets?: Array<{ name?: string }>;
      };

      return new Set(
        (payload.secrets ?? [])
          .map((secret) => secret.name)
          .filter((name): name is string => Boolean(name)),
      );
    } catch {
      return new Set();
    }
  }

  /** True when `branch` exists on the repository. */
  async branchExists(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      { headers: this.http.workspaceHeaders(accessToken) },
    );
    return response.ok;
  }

  /**
   * Whether direct pushes to a branch are blocked by protection rules.
   *
   * Onboarding commits the workflow files straight to the default branch, so a
   * rule requiring pull requests turns the whole attempt into a failure AFTER
   * secrets have been written. Knowing in advance lets the UI say so first.
   *
   * A token that cannot read protection returns `null` — "unknown", never
   * "unprotected". Reporting a guess as a fact is how a preflight becomes worse
   * than no preflight.
   */
  async requiresPullRequestToPush(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean | null> {
    try {
      const response = await this.http.fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
        { headers: this.http.workspaceHeaders(accessToken) },
      );

      // 404 is the documented answer for "this branch has no protection".
      if (response.status === 404) return false;
      if (!response.ok) return null;

      const payload = (await response.json()) as {
        required_pull_request_reviews?: unknown;
      };
      return payload.required_pull_request_reviews != null;
    } catch {
      return null;
    }
  }

  async getBranchProtectionSummary(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GithubBranchProtectionSummary | null> {
    try {
      const response = await this.http.fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
        { headers: this.http.workspaceHeaders(accessToken) },
      );

      // 404 is GitHub's documented answer for "no protection on this branch",
      // where force pushes and deletions are allowed by default.
      if (response.status === 404) {
        return {
          protected: false,
          pullRequestRequired: false,
          allowForcePushes: true,
          allowDeletions: true,
        };
      }
      if (!response.ok) return null;

      const payload = (await response.json()) as {
        required_pull_request_reviews?: unknown;
        allow_force_pushes?: { enabled?: boolean };
        allow_deletions?: { enabled?: boolean };
      };
      return {
        protected: true,
        pullRequestRequired: payload.required_pull_request_reviews != null,
        allowForcePushes: payload.allow_force_pushes?.enabled ?? false,
        allowDeletions: payload.allow_deletions?.enabled ?? false,
      };
    } catch {
      return null;
    }
  }

  async createBranch(
    accessToken: string,
    owner: string,
    repo: string,
    branchName: string,
    fromBranch: string,
  ): Promise<void> {
    let ref: { object: { sha: string } } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
      const refRes = await this.http.fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );
      if (refRes.ok) {
        ref = (await refRes.json()) as { object: { sha: string } };
        break;
      }
    }
    if (!ref) {
      throw new BadGatewayException(
        `Could not resolve '${fromBranch}' branch on GitHub after retries. ` +
          'The repository may not have initialised yet; please retry in a few seconds.',
      );
    }

    const createRes = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/git/refs`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: ref.object.sha,
        }),
      },
    );
    if (!createRes.ok) {
      const err = await createRes.text();
      throw new BadGatewayException(
        `Branch '${branchName}' creation failed (${String(createRes.status)}): ${err}`,
      );
    }
  }

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
  ): Promise<string | null> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub file read failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as GitHubContentResponse;
    if (!payload.content || payload.encoding !== 'base64') {
      return null;
    }

    return Buffer.from(payload.content, 'base64').toString('utf8');
  }

  // ─── Workspace reads ──────────────────────────────────────────────────────
  //
  // Everything below is READ-ONLY and exists to render a project's Code, Pull
  // requests and Pipeline runs tabs. They share one discipline, because they
  // run against an installation token whose rate limit is shared by the whole
  // organisation:
  //
  //   * the run LIST is the only thing a screen may poll;
  //   * a run's jobs load when someone opens that run, never inside the poll;
  //   * a job's log loads when someone opens that job, and is never polled.
  //
  // Breaking that ordering is how a handful of open tabs exhausts the org's
  // hourly budget and every other GitHub call in the product starts failing.

  async listBranches(
    accessToken: string,
    repoFullName: string,
  ): Promise<GitHubBranchSummary[]> {
    const payload = await this.http.workspaceGet<
      Array<{ name: string; protected?: boolean; commit?: { sha?: string } }>
    >(
      `https://api.github.com/repos/${repoFullName}/branches?per_page=100`,
      accessToken,
      'branch list',
    );

    return (payload ?? []).map((branch) => ({
      name: branch.name,
      protected: branch.protected === true,
      commitSha: branch.commit?.sha ?? '',
    }));
  }

  async listBranchHeadAuthors(
    accessToken: string,
    repoFullName: string,
  ): Promise<Map<string, string | null>> {
    const [owner, name] = repoFullName.split('/');
    const response = await this.http.fetchWithRetry(
      'https://api.github.com/graphql',
      {
        method: 'POST',
        headers: {
          ...this.http.workspaceHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query:
            'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:100){nodes{name target{... on Commit{author{user{login}}}}}}}}',
          variables: { owner, name },
        }),
      },
    );
    if (!response.ok) {
      throw new BadGatewayException(
        `GitHub branch authors failed (${String(response.status)})`,
      );
    }
    const payload = (await response.json()) as {
      data?: {
        repository?: {
          refs?: {
            nodes?: Array<{
              name: string;
              target?: { author?: { user?: { login?: string } | null } };
            }>;
          };
        };
      };
    };
    const nodes = payload.data?.repository?.refs?.nodes;
    if (!nodes) {
      throw new BadGatewayException('GitHub branch authors returned no refs');
    }
    return new Map(
      nodes.map((n) => [n.name, n.target?.author?.user?.login ?? null]),
    );
  }

  /**
   * One directory listing, or one file's contents, at a ref.
   *
   * GitHub answers with an array for a directory and an object for a file, so
   * both are normalised into a single response. The caller cannot know which it
   * asked for until the answer arrives, and modelling both here means the
   * browser makes one request per click rather than guessing first.
   */
  async listRepoContents(
    accessToken: string,
    repoFullName: string,
    path: string,
    ref: string,
  ): Promise<GitHubContentListing> {
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    const url =
      `https://api.github.com/repos/${repoFullName}/contents/${cleanPath}` +
      `?ref=${encodeURIComponent(ref)}`;

    const payload = await this.http.workspaceGet<unknown>(
      url,
      accessToken,
      'contents read',
    );

    if (payload === null) {
      return { path: cleanPath, ref, entries: [], file: null };
    }

    if (Array.isArray(payload)) {
      return {
        path: cleanPath,
        ref,
        entries: mapContentEntries(payload as GitHubContentsRow[]),
        file: null,
      };
    }

    return toFileListing(payload as GitHubContentsRow, cleanPath, ref);
  }

  /**
   * Workflow runs for a repository, newest first.
   *
   * THIS is the only workspace read a screen may poll.
   *
   * A page of 20 was too small to show a history. One push runs five
   * workflows - access, env guard, quality, package, verify - on each of three
   * branches, so a single logical change can produce fifteen runs, and a
   * repository scaffolded with several commits in a row filled the whole page
   * with one afternoon's work. The runs that fell off the end did not degrade
   * gracefully: `dev` and `uat` read "no runs" while GitHub plainly had runs
   * for both, because the four that were honestly labelled sat at positions 22
   * to 25.
   *
   * 100 is GitHub's own maximum for this endpoint. Page SIZE is free against
   * the rate limit - the cost is one request either way, and this read is
   * polled, so the request count is what matters and it does not change.
   */
  async listWorkflowRuns(
    accessToken: string,
    repoFullName: string,
    branch?: string | null,
    limit = 100,
  ): Promise<GitHubWorkflowRunSummary[]> {
    const params = new URLSearchParams({
      per_page: String(Math.min(limit, 100)),
    });
    if (branch) params.set('branch', branch);

    const payload = await this.http.workspaceGet<{
      workflow_runs?: GitHubWorkflowRunRow[];
    }>(
      `https://api.github.com/repos/${repoFullName}/actions/runs?${params.toString()}`,
      accessToken,
      'workflow run list',
    );

    return (payload?.workflow_runs ?? []).map((run) => ({
      id: run.id,
      name: run.name ?? 'Workflow',
      displayTitle:
        run.display_title ?? run.head_commit?.message?.split('\n')[0] ?? '',
      headBranch: run.head_branch ?? '',
      headSha: run.head_sha ?? '',
      event: run.event ?? '',
      status: run.status ?? 'unknown',
      conclusion: run.conclusion ?? null,
      runNumber: run.run_number ?? 0,
      runAttempt: run.run_attempt ?? 1,
      htmlUrl: run.html_url ?? '',
      actor: run.actor?.login ?? null,
      createdAt: run.created_at ?? '',
      updatedAt: run.updated_at ?? '',
    }));
  }

  /** One run's jobs and their steps. Loaded on open — never inside a poll. */
  async getWorkflowRunJobs(
    accessToken: string,
    repoFullName: string,
    runId: number,
  ): Promise<GitHubRunJob[]> {
    const payload = await this.http.workspaceGet<{ jobs?: GitHubRunJobRow[] }>(
      `https://api.github.com/repos/${repoFullName}/actions/runs/${String(runId)}/jobs?per_page=100`,
      accessToken,
      'workflow job list',
    );

    return (payload?.jobs ?? []).map((job) => ({
      id: job.id,
      name: job.name ?? '',
      status: job.status ?? 'unknown',
      conclusion: job.conclusion ?? null,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      htmlUrl: job.html_url ?? null,
      steps: (job.steps ?? []).map((step) => ({
        name: step.name ?? '',
        status: step.status ?? 'unknown',
        conclusion: step.conclusion ?? null,
        number: step.number ?? 0,
        startedAt: step.started_at ?? null,
        completedAt: step.completed_at ?? null,
      })),
    }));
  }

  /**
   * One job's console output.
   *
   * The largest response in the product, so it is fetched only when a person
   * opens a job, never polled, and capped before it leaves the server. The cap
   * keeps the TAIL: a failing step's reason is at the end of a log, so the end
   * is the part worth keeping when something has to be dropped.
   */
  async getJobLogs(
    accessToken: string,
    repoFullName: string,
    jobId: number,
    maxChars = 200_000,
  ): Promise<GitHubJobLogResult> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}/actions/jobs/${String(jobId)}/logs`,
      { headers: this.http.workspaceHeaders(accessToken), redirect: 'follow' },
    );

    // 410 Gone is normal, not an error: GitHub expires logs after its
    // retention window, and an old run legitimately has none.
    if (response.status === 410) {
      return { status: 'expired' };
    }

    // 403 and 404 are NOT expiry. A token without Actions-read permission gets
    // a 404 on a private repository's logs (GitHub will not confirm they
    // exist) or a 403. Reporting that as "expired" told people the log was
    // gone when it was only unreadable to us. A 403 that is really a rate
    // limit is excluded: it outlasted the retries, is a transport failure, and
    // is handled below.
    const rateLimited =
      response.status === 403 &&
      (response.headers?.get('retry-after') != null ||
        response.headers?.get('x-ratelimit-remaining') === '0');
    if (response.status === 404 || (response.status === 403 && !rateLimited)) {
      return { status: 'no-access' };
    }

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub job log read failed (${String(response.status)}): ${body.slice(0, 300)}`,
      );
    }

    const text = await response.text();
    if (text.length <= maxChars) {
      return { status: 'ok', content: text, truncated: false };
    }

    return {
      status: 'ok',
      content: text.slice(text.length - maxChars),
      truncated: true,
    };
  }

  async listPullRequests(
    accessToken: string,
    repoFullName: string,
    state: 'open' | 'closed' | 'all' = 'all',
    limit = 30,
  ): Promise<GitHubPullRequestSummary[]> {
    const params = new URLSearchParams({
      state,
      per_page: String(Math.min(limit, 50)),
      sort: 'updated',
      direction: 'desc',
    });

    const payload = await this.http.workspaceGet<GitHubPullRequestRow[]>(
      `https://api.github.com/repos/${repoFullName}/pulls?${params.toString()}`,
      accessToken,
      'pull request list',
    );

    return (payload ?? []).map((pr) => toPullRequestSummary(pr));
  }

  /**
   * The changed files and diffs for one pull request.
   *
   * GitHub omits `patch` for binary files and for very large diffs. That is
   * passed through as null rather than defaulted to an empty string, so the UI
   * can say "diff not shown" instead of rendering a changed file as unchanged.
   */
  async getPullRequestFiles(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
    limit = 100,
  ): Promise<GitHubPullRequestFile[]> {
    const payload = await this.http.workspaceGet<GitHubPullRequestFileRow[]>(
      `https://api.github.com/repos/${repoFullName}/pulls/${String(pullNumber)}/files?per_page=${String(Math.min(limit, 100))}`,
      accessToken,
      'pull request file list',
    );

    return (payload ?? []).map((file) => toPullRequestFile(file));
  }

  async putFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    const encodedContent = Buffer.from(content, 'utf8').toString('base64');
    let existingSha: string | undefined;

    const checkRes = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (checkRes.ok) {
      const existing = (await checkRes.json()) as GitHubContentResponse;
      existingSha = existing.sha;
    } else if (checkRes.status !== 404) {
      const body = await checkRes.text();
      throw new BadGatewayException(
        `GitHub file lookup failed (${String(checkRes.status)}): ${body}`,
      );
    }

    const body: Record<string, unknown> = {
      message,
      content: encodedContent,
      branch,
    };

    if (existingSha) {
      body.sha = existingSha;
    }

    const putRes = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!putRes.ok) {
      const errorBody = await putRes.text();
      throw new BadGatewayException(
        `GitHub file write failed (${String(putRes.status)}): ${errorBody}`,
      );
    }

    const payload = (await putRes.json()) as GitHubContentsWriteResponse;
    return {
      commitSha: payload.commit?.sha ?? '',
      commitUrl: payload.commit?.html_url ?? payload.content?.html_url ?? null,
    };
  }

  async createPullRequest(
    accessToken: string,
    owner: string,
    repo: string,
    pullRequest: { title: string; head: string; base: string; body?: string },
  ): Promise<{ number: number; htmlUrl: string }> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pullRequest),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub pull request creation failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as GitHubPullRequestResponse;
    if (!payload.number || !payload.html_url) {
      throw new BadGatewayException(
        'GitHub pull request response was incomplete',
      );
    }

    return { number: payload.number, htmlUrl: payload.html_url };
  }

  /**
   * One pull request in detail, including whether GitHub will let it merge.
   *
   * The list endpoint omits `mergeable_state`, and that is the field the
   * product needs: it is the difference between "cannot merge" and "cannot
   * merge because a review is required". GitHub computes it asynchronously and
   * answers `unknown` until it has, which is passed through rather than
   * guessed at.
   *
   * A missing pull request is null, not an error: a number typed into a URL is
   * a normal way to arrive at one that does not exist.
   */
  async getPullRequest(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestDetail | null> {
    const payload = await this.http.workspaceGet<GitHubPullRequestRow>(
      `https://api.github.com/repos/${repoFullName}/pulls/${String(pullNumber)}`,
      accessToken,
      'pull request detail',
    );

    return payload ? toPullRequestDetail(payload) : null;
  }

  /**
   * The checks GitHub ran against a pull request's head commit.
   *
   * Both APIs are read, because they report different things and a pipeline
   * can use either: check RUNS come from GitHub Actions and apps, while the
   * combined STATUS covers older integrations that post commit statuses. Asking
   * only for check runs would show a green pull request whose required status
   * context had failed.
   */
  async getPullRequestChecks(
    accessToken: string,
    repoFullName: string,
    headSha: string,
  ): Promise<GitHubPullRequestCheck[]> {
    const runs = await this.http.workspaceGet<{
      check_runs?: GitHubCheckRunRow[];
    }>(
      `https://api.github.com/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100`,
      accessToken,
      'pull request check runs',
    );

    const checkRunRows = runs?.check_runs ?? [];
    // The workflow lookup is only worth a call when an Actions check exists.
    const workflows = checkRunRows.some(
      (row) => row.app?.slug === ACTIONS_APP_SLUG,
    )
      ? await this.workflowsByCheckSuite(accessToken, repoFullName, headSha)
      : new Map<number, CheckWorkflowInfo>();

    const checks: GitHubPullRequestCheck[] = checkRunRows.map((row) =>
      toCheckRunCheck(row, workflows),
    );

    const combined = await this.http.workspaceGet<{
      statuses?: GitHubCommitStatusRow[];
    }>(
      `https://api.github.com/repos/${repoFullName}/commits/${headSha}/status`,
      accessToken,
      'pull request commit status',
    );

    for (const status of combined?.statuses ?? []) {
      checks.push(toStatusCheck(status));
    }

    await this.attachAnnotations(accessToken, repoFullName, checks);

    return checks;
  }

  /**
   * Which workflow each check suite of a commit belongs to.
   *
   * Fail-soft by design: this only adds a label to checks that are already in
   * hand, so a failed lookup must never take the pull request detail down with
   * it. An empty map leaves `workflowName` and `event` null.
   */
  private async workflowsByCheckSuite(
    accessToken: string,
    repoFullName: string,
    headSha: string,
  ): Promise<Map<number, CheckWorkflowInfo>> {
    try {
      const payload = await this.http.workspaceGet<{
        workflow_runs?: GitHubCheckSuiteRunRow[];
      }>(
        `https://api.github.com/repos/${repoFullName}/actions/runs?head_sha=${headSha}&per_page=100`,
        accessToken,
        'workflow runs for a commit',
      );
      return indexWorkflowRunsByCheckSuite(payload?.workflow_runs ?? []);
    } catch (error) {
      this.logger.warn(
        `Could not map checks to workflows for ${repoFullName}@${headSha}: ${String(error)}`,
      );
      return new Map();
    }
  }

  /**
   * Attach the errors GitHub recorded to the failed check runs, in place.
   *
   * Only failed runs, and only the first few: each is a request, and a
   * passing check has nothing to explain. Fail-soft per check: a token
   * without `checks: read` makes every lookup fail, and the pull request must
   * still render, just without the extra detail.
   */
  private async attachAnnotations(
    accessToken: string,
    repoFullName: string,
    checks: GitHubPullRequestCheck[],
  ): Promise<void> {
    const failed = checks.filter(isFailedCheck).slice(0, MAX_ANNOTATED_CHECKS);

    await Promise.all(
      failed.map(async (check) => {
        try {
          const rows = await this.http.workspaceGet<GitHubAnnotationRow[]>(
            `https://api.github.com/repos/${repoFullName}/check-runs/${String(check.id)}/annotations?per_page=50`,
            accessToken,
            'check run annotations',
          );
          if (rows) {
            check.annotations = toCodeAnnotations(rows);
          }
        } catch (error) {
          this.logger.warn(
            `Could not read annotations for check ${String(check.id)} in ${repoFullName}: ${String(error)}`,
          );
        }
      }),
    );
  }

  /**
   * Ask GitHub to merge a pull request.
   *
   * A refusal is returned, not thrown, when GitHub explains it: 405 is
   * "not mergeable" (a protection rule, a conflict) and 409 is "the head moved
   * since you looked". Both are answers a person can act on, and turning them
   * into a 502 would lose the sentence that says which one it was. Anything
   * else is a genuine transport failure and still throws.
   */
  async mergePullRequest(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
    options: { method?: 'merge' | 'squash' | 'rebase'; sha?: string } = {},
  ): Promise<GitHubMergeResult> {
    const body: Record<string, string> = {
      merge_method: options.method ?? 'merge',
    };
    if (options.sha) body['sha'] = options.sha;

    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}/pulls/${String(pullNumber)}/merge`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    const text = await response.text();

    if (response.status === 405 || response.status === 409) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // Leave the raw body: an unparseable refusal is still the reason.
      }
      return { merged: false, message, sha: null };
    }

    // The merge is made with the person's own token, so a revoked sign-in or
    // missing write access is theirs to act on, not a gateway failure.
    const refusal = userWriteRefusal(
      response.status,
      response.headers?.get('x-ratelimit-remaining') === '0',
      repoFullName,
    );
    if (refusal) {
      return { merged: false, message: refusal, sha: null };
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `GitHub merge failed (${String(response.status)}): ${text.slice(0, 300)}`,
      );
    }

    const parsed = JSON.parse(text) as {
      merged?: boolean;
      message?: string;
      sha?: string;
    };

    return {
      merged: parsed.merged === true,
      message: parsed.message ?? 'Merged.',
      sha: parsed.sha ?? null,
    };
  }

  /**
   * What a pull request from `head` into `base` would contain.
   *
   * One read answers the compose screen: ahead/behind, the commits, and the
   * per-file diffs. A missing ref is GitHub's 404, which comes back as null so
   * the caller can say which branch is gone instead of reporting a 502.
   */
  async compareBranches(
    accessToken: string,
    repoFullName: string,
    base: string,
    head: string,
  ): Promise<GitHubBranchComparison | null> {
    const payload = await this.http.workspaceGet<GitHubCompareRow>(
      `https://api.github.com/repos/${repoFullName}/compare/${encodeRef(base)}...${encodeRef(head)}`,
      accessToken,
      'branch comparison',
    );

    return payload ? toBranchComparison(payload) : null;
  }

  /**
   * Who GitHub attributes a single commit to, for best-effort notification
   * attribution (never a full commit view — see GitHubCommitAuthor).
   *
   * `author.login` is only present when the commit is linked to a GitHub
   * account; an unlinked email (a bot, a squash-merge service account)
   * comes back as `author: null` from GitHub itself, which this passes
   * through as `login: null` rather than falling back to the free-text git
   * author name the way toComparisonCommit does for the branch-comparison
   * UI — attribution needs a real account to map to an ALPHACI user, and a
   * display name that cannot be mapped is not a fallback worth guessing at.
   */
  async getCommitAuthor(
    accessToken: string,
    repoFullName: string,
    sha: string,
  ): Promise<GitHubCommitAuthor | null> {
    const payload = await this.http.workspaceGet<{
      author?: { login?: string } | null;
      parents?: unknown[];
    }>(
      `https://api.github.com/repos/${repoFullName}/commits/${encodeURIComponent(sha)}`,
      accessToken,
      'commit detail',
    );

    if (!payload) {
      return null;
    }

    return {
      login: payload.author?.login ?? null,
      isMergeCommit: (payload.parents?.length ?? 0) > 1,
    };
  }

  async findOpenPullRequest(
    accessToken: string,
    repoFullName: string,
    head: string,
    base: string,
  ): Promise<GitHubPullRequestSummary | null> {
    // GitHub's `head` filter wants `owner:branch`, even inside the same
    // repository; a bare branch name is silently ignored and matches every
    // open pull request.
    const owner = repoFullName.split('/')[0] ?? '';
    const params = new URLSearchParams({
      state: 'open',
      head: `${owner}:${head}`,
      base,
      per_page: '1',
    });

    const payload = await this.http.workspaceGet<GitHubPullRequestRow[]>(
      `https://api.github.com/repos/${repoFullName}/pulls?${params.toString()}`,
      accessToken,
      'open pull request lookup',
    );

    const first = payload?.[0];
    return first ? toPullRequestSummary(first) : null;
  }

  /**
   * Open a pull request on a person's behalf.
   *
   * 422 is GitHub's validation refusal — no commits between the branches, a
   * pull request that already exists, a missing branch — and is returned with
   * GitHub's own sentence. 401 is a revoked or replaced sign-in, answered
   * with "sign in again". 403 and 404 are the token's owner lacking write
   * access (GitHub answers 404 for a private repository it will not reveal),
   * which is also an answer for that person. Anything else is a transport
   * failure and throws.
   */
  async openPullRequest(
    accessToken: string,
    repoFullName: string,
    input: GitHubOpenPullRequestInput,
  ): Promise<GitHubOpenPullRequestResult> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}/pulls`,
      {
        method: 'POST',
        headers: {
          ...this.http.workspaceHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          ...(input.body ? { body: input.body } : {}),
          draft: input.draft === true,
        }),
      },
    );

    const text = await response.text();

    if (response.status === 422) {
      return { created: false, message: validationMessage(text) };
    }

    const refusal = userWriteRefusal(
      response.status,
      response.headers?.get('x-ratelimit-remaining') === '0',
      repoFullName,
    );
    if (refusal) {
      return { created: false, message: refusal };
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `GitHub pull request creation failed (${String(response.status)}): ${text.slice(0, 300)}`,
      );
    }

    return {
      created: true,
      pullRequest: toPullRequestSummary(
        JSON.parse(text) as GitHubPullRequestRow,
      ),
    };
  }

  readRepoFiles(
    accessToken: string,
    repoFullName: string,
    ref: string,
    paths: readonly string[],
  ): Promise<GitHubRepoFilesResult> {
    return this.repoFiles.readRepoFiles(accessToken, repoFullName, ref, paths);
  }

  commitFilesToNewBranch(
    accessToken: string,
    repoFullName: string,
    input: GitHubCommitFilesInput,
  ): Promise<GitHubCommitFilesResult> {
    return this.repoFiles.commitFilesToNewBranch(
      accessToken,
      repoFullName,
      input,
    );
  }

  /**
   * Dispatch a workflow_dispatch run on a person's behalf — the first
   * caller of this GitHub endpoint. Used to re-run the verify (Playwright)
   * workflow for a QA run's branch, attributed to the person who asked for
   * it rather than a service token. GitHub answers 204 with no body on
   * success; `workflowFile` is the filename (e.g.
   * "30-alphaci-verify.yml"), not a path.
   */
  async dispatchWorkflow(
    accessToken: string,
    repoFullName: string,
    workflowFile: string,
    ref: string,
  ): Promise<GitHubDispatchWorkflowResult> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      {
        method: 'POST',
        headers: {
          ...this.http.workspaceHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref }),
      },
    );

    if (response.status === 401) {
      return {
        dispatched: false,
        reason: 'unauthorized',
        message:
          userWriteRefusal(401, false, repoFullName) ??
          'GitHub no longer accepts your sign-in.',
      };
    }

    if (response.status === 404) {
      return {
        dispatched: false,
        reason: 'not_found',
        message: `No workflow named "${workflowFile}" was found on ${ref} in ${repoFullName}.`,
      };
    }

    if (response.status === 403) {
      const text = await response.text();
      return {
        dispatched: false,
        reason: 'forbidden',
        message: validationMessage(text),
      };
    }

    if (!response.ok) {
      const text = await response.text();
      throw new BadGatewayException(
        `GitHub workflow dispatch failed (${String(response.status)}): ${text.slice(0, 300)}`,
      );
    }

    return { dispatched: true };
  }

  async setActionsSecret(
    accessToken: string | null | undefined,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
    options: { throwOnFailure?: boolean } = {},
  ): Promise<void> {
    if (!accessToken) {
      const message = `setActionsSecret: no token available for ${owner}/${repo}/${secretName}, skipping`;
      if (options.throwOnFailure) {
        throw new BadGatewayException(message);
      }
      this.logger.warn(message);
      return;
    }

    const keyRes = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!keyRes.ok) {
      const body = await keyRes.text();
      const message = `setActionsSecret: failed to fetch public key for ${owner}/${repo} (${String(keyRes.status)}): ${body}`;
      if (options.throwOnFailure) {
        throw new BadGatewayException(message);
      }
      this.logger.warn(message);
      return;
    }

    const keyPayload = (await keyRes.json()) as { key_id: string; key: string };

    await sodium.ready;
    const keyBytes = sodium.from_base64(
      keyPayload.key,
      sodium.base64_variants.ORIGINAL,
    );
    const secretBytes = sodium.from_string(secretValue);
    const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
    const encryptedValue = sodium.to_base64(
      encryptedBytes,
      sodium.base64_variants.ORIGINAL,
    );

    const putRes = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: keyPayload.key_id,
        }),
      },
    );

    if (!putRes.ok && putRes.status !== 204) {
      const body = await putRes.text();
      const message = `setActionsSecret: failed to set ${secretName} on ${owner}/${repo} (${String(putRes.status)}): ${body}`;
      if (options.throwOnFailure) {
        throw new BadGatewayException(message);
      }
      this.logger.warn(message);
    }
  }

  async setActionsSecretStrict(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void> {
    await this.setActionsSecret(
      accessToken,
      owner,
      repo,
      secretName,
      secretValue,
      { throwOnFailure: true },
    );
  }

  /**
   * Create-or-update an Actions VARIABLE, which is not a quieter secret.
   *
   * The two are not interchangeable and both are installed deliberately. A
   * workflow can interpolate a variable inside a reusable-workflow `with:`
   * block; GitHub rejects the whole file at parse time when a secret appears
   * there, and redacts a secret routed through a job output. So every address
   * a later stage has to be *handed* — a deployment hostname, a health URL —
   * can only travel as a variable, even when the same value is also installed
   * as a secret for the workflow that receives it through `secrets:`.
   *
   * No sealed box here: variables are stored and read back in plaintext, which
   * is why nothing confidential may be written through this method.
   *
   * PATCH-then-POST because the variables API has no idempotent PUT. A 404
   * from the PATCH is the documented way to learn the variable does not exist
   * yet, so it is a branch rather than a failure.
   */
  async setActionsVariable(
    accessToken: string | null | undefined,
    owner: string,
    repo: string,
    variableName: string,
    variableValue: string,
    options: { throwOnFailure?: boolean } = {},
  ): Promise<void> {
    const fail = (message: string): void => {
      if (options.throwOnFailure) {
        throw new BadGatewayException(message);
      }
      this.logger.warn(message);
    };

    if (!accessToken) {
      fail(
        `setActionsVariable: no token available for ${owner}/${repo}/${variableName}, skipping`,
      );
      return;
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cicd-workflow-product',
      'Content-Type': 'application/json',
    };
    const body = JSON.stringify({ name: variableName, value: variableValue });

    const patchRes = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/actions/variables/${variableName}`,
      { method: 'PATCH', headers, body },
    );

    if (patchRes.ok || patchRes.status === 204) {
      return;
    }

    if (patchRes.status !== 404) {
      const detail = await patchRes.text();
      fail(
        `setActionsVariable: failed to update ${variableName} on ${owner}/${repo} (${String(patchRes.status)}): ${detail}`,
      );
      return;
    }

    const createRes = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/actions/variables`,
      { method: 'POST', headers, body },
    );

    if (!createRes.ok && createRes.status !== 201) {
      const detail = await createRes.text();
      fail(
        `setActionsVariable: failed to create ${variableName} on ${owner}/${repo} (${String(createRes.status)}): ${detail}`,
      );
    }
  }

  async setActionsVariableStrict(
    accessToken: string,
    owner: string,
    repo: string,
    variableName: string,
    variableValue: string,
  ): Promise<void> {
    await this.setActionsVariable(
      accessToken,
      owner,
      repo,
      variableName,
      variableValue,
      { throwOnFailure: true },
    );
  }

  /**
   * Pull-request-only protection that keeps what the branch already has; see
   * github-branch-protection.ts for the rule and the merge. Provisioning seeds
   * the env-guard check (the guard workflow runs on every push and pull
   * request to a pipeline branch, so the context is always present on PR head
   * commits of provisioned repos).
   */
  ensurePullRequestProtection(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    options?: GithubPullRequestProtectionOptions,
  ): Promise<GithubBranchProtectionOutcome> {
    return ensurePullRequestProtection(
      this.http,
      accessToken,
      owner,
      repo,
      branch,
      options,
    );
  }

  listCommits(
    accessToken: string,
    repoFullName: string,
    query: GitHubCommitListQuery,
  ): Promise<GitHubCommitPage> {
    return this.activity.listCommits(accessToken, repoFullName, query);
  }

  listRepositoryEvents(
    accessToken: string,
    repoFullName: string,
    options?: { etag?: string | null },
  ): Promise<GitHubRepositoryEventsResult> {
    return this.activity.listRepositoryEvents(
      accessToken,
      repoFullName,
      options,
    );
  }

  compareCommits(
    accessToken: string,
    repoFullName: string,
    base: string,
    head: string,
    limit?: number,
  ): Promise<GitHubPushCommits | null> {
    return this.activity.compareCommits(
      accessToken,
      repoFullName,
      base,
      head,
      limit,
    );
  }

  getPullRequestHeadline(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestHeadline | null> {
    return this.activity.getPullRequestHeadline(
      accessToken,
      repoFullName,
      pullNumber,
    );
  }

  private fetchInstallationRepositories(
    accessToken: string,
  ): Promise<string[]> {
    return this.installationLinker.fetchInstallationRepositories(accessToken);
  }

  private base64UrlJson(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }
}
