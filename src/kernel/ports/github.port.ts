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

/** One commit a branch comparison would bring into the base. */
export interface GitHubComparisonCommit {
  sha: string;
  /** The first line of the commit message only. */
  headline: string;
  author: string | null;
  authoredAt: string | null;
}

/**
 * Who GitHub attributes a single commit to, for best-effort "author of
 * record" notifications — never a full commit view.
 *
 * `login` is null when the commit is not linked to a GitHub account (a bot, a
 * squash-merge service account, or a git author email GitHub could not
 * match) — callers should treat that the same as "unknown" and not retry.
 * `isMergeCommit` is true when the commit has more than one parent; callers
 * attributing a defect or a change to "the person who wrote it" should skip
 * merge commits rather than crediting whoever happened to click merge.
 */
export interface GitHubCommitAuthor {
  login: string | null;
  isMergeCommit: boolean;
}

/**
 * What a pull request from `head` into `base` would contain, before one exists.
 *
 * `status` is GitHub's own word for how the two branches relate: `identical`
 * and `behind` both mean there is nothing to merge, which is the answer the
 * compose screen has to give before anyone types a title.
 */
export interface GitHubBranchComparison {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  commits: GitHubComparisonCommit[];
  files: GitHubPullRequestFile[];
  /**
   * GitHub stops listing files at 300 in a comparison. True means the list is
   * a prefix, so the UI must not present it as the whole change.
   */
  filesTruncated: boolean;
}

export interface GitHubOpenPullRequestInput {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

/**
 * The outcome of asking GitHub to open a pull request.
 *
 * A refusal is an answer, not a failure: "No commits between main and x" and
 * "A pull request already exists" are GitHub's validation sentences, and the
 * point of opening pull requests in the product is to repeat them.
 */
export type GitHubOpenPullRequestResult =
  | { created: true; pullRequest: GitHubPullRequestSummary }
  | { created: false; message: string };

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
  /** Null when either ref does not exist in the repository. */
  compareBranches(
    accessToken: string,
    repoFullName: string,
    base: string,
    head: string,
  ): Promise<GitHubBranchComparison | null>;
  /** The open pull request from `head` into `base`, if there is one. */
  findOpenPullRequest(
    accessToken: string,
    repoFullName: string,
    head: string,
    base: string,
  ): Promise<GitHubPullRequestSummary | null>;
  /**
   * Open a pull request on a person's behalf.
   *
   * Distinct from `createPullRequest`, which the provisioning flows use and
   * which throws on every refusal: here GitHub's validation message is the
   * answer the person needs, so it is returned rather than thrown.
   */
  openPullRequest(
    accessToken: string,
    repoFullName: string,
    input: GitHubOpenPullRequestInput,
  ): Promise<GitHubOpenPullRequestResult>;
  /**
   * Dispatch a `workflow_dispatch` run on a person's behalf — first caller:
   * QA automation's "Run Playwright" (re-dispatches the generated verify
   * workflow for a QA run's branch, attributed to the signed-in user).
   * GitHub answers 204 with no body on success.
   */
  dispatchWorkflow(
    accessToken: string,
    repoFullName: string,
    workflowFile: string,
    ref: string,
  ): Promise<GitHubDispatchWorkflowResult>;
  /**
   * Who GitHub attributes `sha` to, and whether it is a merge commit. Null
   * when the commit does not exist on this repository (or the token cannot
   * see it) — GitHub does not distinguish the two, and neither does the
   * caller.
   */
  getCommitAuthor(
    accessToken: string,
    repoFullName: string,
    sha: string,
  ): Promise<GitHubCommitAuthor | null>;
}

/**
 * The outcome of asking GitHub to dispatch a workflow_dispatch run.
 *
 * `unauthorized` (401) and `forbidden` (403) are the token's own refusal,
 * same distinction userWriteRefusal draws elsewhere in this file.
 * `not_found` (404) means either the workflow file does not exist on `ref`
 * or the token cannot see the repository — GitHub does not distinguish the
 * two, and neither does the caller: both read as "no verify workflow yet".
 */
export type GitHubDispatchWorkflowResult =
  | { dispatched: true }
  | {
      dispatched: false;
      reason: 'unauthorized' | 'forbidden' | 'not_found';
      message: string;
    };

export interface GithubTeamMembershipChangedEvent {
  action: string;
  login: string;
  teamSlug: string;
  installationId: number;
}

export interface GithubOrganizationMember {
  login: string;
  avatarUrl: string | null;
}

export interface GithubOrganizationPort {
  getEnforcedOrg(): string;
  onTeamMembershipChanged(
    listener: (event: GithubTeamMembershipChangedEvent) => void,
  ): void;
  /**
   * Every member of `org`, read with the first credential GitHub accepts:
   * the caller's own OAuth token (read:org), then the caller's App
   * installation, then the org's App installation.
   *
   * Returns null when no credential could read the roster. Null means
   * "unknown", never "nobody": callers must not treat it as an empty org.
   */
  readOrganizationMembers(input: {
    org: string;
    userId: string;
    userToken: string | null;
  }): Promise<GithubOrganizationMember[] | null>;
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
