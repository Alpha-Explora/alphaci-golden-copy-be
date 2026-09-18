/**
 * Provider-neutral GitHub capabilities consumed by other bounded contexts.
 *
 * These are application ports, not a second GitHub SDK. The Pipelines context
 * owns the adapter and binds it to these tokens at the composition boundary;
 * Projects and Identity Access only depend on the narrow operation surface
 * they need.
 */

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface GithubCreateRepoInput {
  repoName: string;
  description?: string;
  private: boolean;
}

/**
 * Why GitHub did not delete a repository, as far as the response establishes.
 *
 * Every 401 and 403 used to be reported as `missing_scope`, and the response
 * body was thrown away, so the one explanation GitHub gave was lost and a
 * guess took its place. Two real deletions were refused that way while the
 * login requested `delete_repo` and the user was an organisation admin -
 * "reconnect your account" was not the fix. Each code now means something the
 * response actually showed:
 *
 *   missing_scope   the token's own X-OAuth-Scopes header lacks delete_repo
 *   org_restricted  GitHub said the organisation restricts OAuth app access
 *   token_rejected  401, or no token on the session at all
 *   forbidden       403 for a reason the response does not name
 *   not_found       404 - already deleted, or no longer visible to this token
 *   other           any other status
 */
export type GithubRepoDeleteErrorCode =
  | 'missing_scope'
  | 'org_restricted'
  | 'token_rejected'
  | 'forbidden'
  | 'not_found'
  | 'other';

export class GithubRepoDeleteError extends Error {
  constructor(
    public readonly code: GithubRepoDeleteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GithubRepoDeleteError';
  }
}

export interface GithubRepositoryDeletedEvent {
  repoFullName: string;
}

export interface GitHubBranchSummary {
  name: string;
  protected: boolean;
  commitSha: string;
}

export type GitHubContentEntryType = 'file' | 'dir' | 'symlink' | 'submodule';

export interface GitHubContentEntry {
  name: string;
  path: string;
  type: GitHubContentEntryType;
  size: number;
  sha: string;
}

export interface GitHubContentListing {
  path: string;
  ref: string;
  entries: GitHubContentEntry[];
  file: GitHubFileContent | null;
}

export interface GitHubFileContent {
  name: string;
  path: string;
  size: number;
  sha: string;
  content: string | null;
  truncated: boolean;
  htmlUrl: string | null;
}

export interface GitHubWorkflowRunSummary {
  id: number;
  name: string;
  displayTitle: string;
  headBranch: string;
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
  runNumber: number;
  runAttempt: number;
  htmlUrl: string;
  actor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubRunStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitHubRunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
  steps: GitHubRunStep[];
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  author: string | null;
  authorAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

/**
 * One pull request in detail, including whether GitHub will let it merge.
 *
 * `mergeableState` is the field that matters and the one a list cannot give:
 * `blocked` means a protection rule stands in the way (a missing review, a
 * failing required check), `dirty` means the branch conflicts, `clean` means
 * it will merge. Surfacing it is what lets the product explain a refusal
 * instead of only reporting one.
 */
export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
  /** GitHub's own verdict: null while it is still computing one. */
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
  body: string | null;
}

/** One check GitHub ran against a pull request's head commit. */
export interface GitHubPullRequestCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** The outcome of asking GitHub to merge. */
export interface GitHubMergeResult {
  merged: boolean;
  message: string;
  sha: string | null;
}

export interface GitHubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
}

export interface GithubProjectPort {
  getEnforcedOrg(): string;
  /**
   * Backwards-compatible event surface for direct adapters/tests. Production
   * callers should prefer the narrow named subscription below.
   */
  on?(
    event: string,
    listener: (event: GithubRepositoryDeletedEvent) => void,
  ): unknown;
  onRepositoryDeleted(
    listener: (event: GithubRepositoryDeletedEvent) => void,
  ): void;
  createRepo(
    accessToken: string,
    input: GithubCreateRepoInput,
    ownerLogin?: string,
  ): Promise<{
    repoUrl: string;
    cloneUrl: string;
    ownerLogin: string;
    repoName: string;
  }>;
  deleteRepo(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<boolean>;
  deleteRepoForUser(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<void>;
  repoExists(accessToken: string, repoFullName: string): Promise<boolean>;
  getRepo(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepo>;
  getInstallationAccessTokenForUser(userId: string): Promise<string | null>;
  getInstallationAccessTokenForUserRepo(
    userId: string,
    repoFullName: string,
  ): Promise<string | null>;
  getOrganizationProvisioningContext(
    userId: string,
    installationId: number,
  ): Promise<{ accessToken: string; ownerLogin: string }>;
  getOrganizationProvisioningContextByLogin(
    orgLogin: string,
  ): Promise<{ accessToken: string; ownerLogin: string }>;
  deleteActionsSecret(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
  ): Promise<void>;
  listActionsSecretNames(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<Set<string>>;
  branchExists(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean>;
  requiresPullRequestToPush(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<boolean | null>;
  createBranch(
    accessToken: string,
    owner: string,
    repo: string,
    branchName: string,
    fromBranch: string,
  ): Promise<void>;
  getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
  ): Promise<string | null>;
  putFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<{ commitSha: string; commitUrl: string | null }>;
  createPullRequest(
    accessToken: string,
    owner: string,
    repo: string,
    pullRequest: { title: string; head: string; base: string; body?: string },
  ): Promise<{ number: number; htmlUrl: string }>;
  setActionsSecret(
    accessToken: string | null | undefined,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
    options?: { throwOnFailure?: boolean },
  ): Promise<void>;
  setActionsSecretStrict(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void>;
  setActionsVariableStrict(
    accessToken: string,
    owner: string,
    repo: string,
    variableName: string,
    variableValue: string,
  ): Promise<void>;
  applyBranchProtection(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    requiredStatusChecks?: string[],
  ): Promise<void>;
  listBranches(
    accessToken: string,
    repoFullName: string,
  ): Promise<GitHubBranchSummary[]>;
  listRepoContents(
    accessToken: string,
    repoFullName: string,
    path: string,
    ref: string,
  ): Promise<GitHubContentListing>;
  listWorkflowRuns(
    accessToken: string,
    repoFullName: string,
    branch?: string | null,
    limit?: number,
  ): Promise<GitHubWorkflowRunSummary[]>;
  getWorkflowRunJobs(
    accessToken: string,
    repoFullName: string,
    runId: number,
  ): Promise<GitHubRunJob[]>;
  getJobLogs(
    accessToken: string,
    repoFullName: string,
    jobId: number,
    maxChars?: number,
  ): Promise<{ content: string; truncated: boolean } | null>;
  listPullRequests(
    accessToken: string,
    repoFullName: string,
    state?: 'open' | 'closed' | 'all',
    limit?: number,
  ): Promise<GitHubPullRequestSummary[]>;
  getPullRequestFiles(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
    limit?: number,
  ): Promise<GitHubPullRequestFile[]>;
  getPullRequest(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestDetail | null>;
  getPullRequestChecks(
    accessToken: string,
    repoFullName: string,
    headSha: string,
  ): Promise<GitHubPullRequestCheck[]>;
  mergePullRequest(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
    options?: { method?: 'merge' | 'squash' | 'rebase'; sha?: string },
  ): Promise<GitHubMergeResult>;
}

export interface GithubTeamMembershipChangedEvent {
  action: string;
  login: string;
  teamSlug: string;
  installationId: number;
}

export interface GithubOrganizationPort {
  getEnforcedOrg(): string;
  onTeamMembershipChanged(
    listener: (event: GithubTeamMembershipChangedEvent) => void,
  ): void;
  listOrganizationMembers(
    userId: string,
  ): Promise<Array<{ login: string; avatarUrl: string | null }>>;
  getTeamMembership(
    teamSlug: string,
    login: string,
    token: string,
  ): Promise<boolean | null>;
  listTeamMembers(userId: string, teamSlug: string): Promise<string[]>;
  listTeamMembersWithToken(teamSlug: string, token: string): Promise<string[]>;
  createInstallationAccessToken(installationId: number): Promise<string>;
  getInstallationAccessTokenForUser(userId: string): Promise<string | null>;
  getInstallationAccessTokenForUserRepo(
    userId: string,
    repoFullName: string,
  ): Promise<string | null>;
  getOrganizationProvisioningContextByLogin(
    orgLogin: string,
  ): Promise<{ accessToken: string; ownerLogin: string }>;
}

export const GITHUB_PROJECT_PORT = Symbol('GithubProjectPort');
export const GITHUB_ORGANIZATION_PORT = Symbol('GithubOrganizationPort');
