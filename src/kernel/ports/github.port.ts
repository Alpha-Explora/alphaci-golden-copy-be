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

/**
 * One line GitHub attached to a check run: a lint error, a failing test, a
 * compiler message. These are the actual errors, with a file and a line.
 */
export interface GitHubCheckAnnotation {
  path: string;
  line: number | null;
  /** GitHub's own vocabulary: `failure`, `warning` or `notice`. */
  level: string;
  title: string | null;
  message: string;
}

/**
 * One check GitHub ran against a pull request's head commit.
 *
 * The identity and detail fields below were added after the first six, and are
 * always present (null when GitHub has nothing to say) except `annotations`,
 * which is omitted when it was not looked up.
 */
export interface GitHubPullRequestCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The check run id; null for a commit status, which has none. */
  id: number | null;
  /** A check run (Actions or an app) or a legacy commit status. */
  kind: 'check-run' | 'status';
  /**
   * The workflow this check belongs to. Two jobs of the same name from two
   * workflows are otherwise indistinguishable. Null when the check did not
   * come from GitHub Actions, or the workflow lookup failed.
   */
  workflowName: string | null;
  /** The event that triggered that workflow (`pull_request`, `push`, ...). */
  event: string | null;
  /**
   * The Actions job id, so the product can open the job's own log. For a
   * GitHub Actions check run the check-run id IS the job id; null for any
   * other app and for statuses.
   */
  jobId: number | null;
  /** The check run's `output.title`. */
  title: string | null;
  /** The check run's `output.summary`, cut to a readable length. */
  summary: string | null;
  /** A commit status's description. Null for check runs. */
  description: string | null;
  /**
   * The errors GitHub recorded against a FAILED check run. Present (possibly
   * empty) only when they were looked up; absent for passing checks, for
   * statuses, and when the lookup failed.
   */
  annotations?: GitHubCheckAnnotation[];
}

/**
 * What reading a job log can honestly say.
 *
 * `expired` and `no-access` used to be one `null`, so a token that simply could
 * not read the logs of a private repository was reported as "the log expired".
 */
export type GitHubJobLogResult =
  | { status: 'ok'; content: string; truncated: boolean }
  /** GitHub says the log is gone (410). */
  | { status: 'expired' }
  /**
   * 403 or 404: GitHub answers a token that may not read Actions logs with a
   * 404 as often as a 403, so this does not prove the log exists. Callers that
   * know the job's age can still decide an old one has simply expired.
   */
  | { status: 'no-access' };

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

/** The status GitHub reports for `compare/{base}...{head}`, from the HEAD's side. */
export type GitHubBranchRelation = GitHubBranchComparison['status'];

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

/**
 * What reading a handful of paths at one ref found.
 *
 * `content` is null for a file that exists but could not be decoded as text
 * (a directory, a binary, an empty file) - `exists` is the question callers
 * mostly ask.
 */
export interface GitHubRepoFileProbe {
  exists: boolean;
  content: string | null;
}

/**
 * `unauthorized` is GitHub no longer accepting the token (401). Every other
 * refusal on a read is a transport failure and throws.
 */
export type GitHubRepoFilesResult =
  | { read: true; files: Record<string, GitHubRepoFileProbe> }
  | { read: false; reason: 'unauthorized'; message: string };

/**
 * Every file path at a ref (GitHub's recursive tree). `truncated` is GitHub
 * saying the tree was too large to list in full (over 100,000 entries).
 */
export type GitHubRepoPathsResult =
  | { read: true; paths: string[]; truncated: boolean }
  | { read: false; reason: 'unauthorized'; message: string };

/** What the caller may do on a repository, as GitHub reports it to them. */
export interface GitHubRepoPermissions {
  push: boolean;
  admin: boolean;
}

/**
 * Permissions an installation token is narrowed to, by GitHub's own names
 * (`contents`, `workflows`, `secrets`, `pull_requests`). Only what a
 * repair needs, never the App's full set.
 */
export type GitHubTokenPermissions = Readonly<Record<string, 'read' | 'write'>>;

export interface GitHubCommitFilesInput {
  /** Existing branch the new one starts from. */
  fromBranch: string;
  /**
   * The commit `fromBranch` was read at. When given, the new branch is built on
   * it, and the commit fails with `base_moved` if the branch has moved since,
   * rather than building on a head the caller never read.
   */
  fromSha?: string;
  /** Branch to create. Created LAST, so a failure leaves nothing behind. */
  newBranch: string;
  message: string;
  /** Full file contents (UTF-8) to add or replace in the one commit. */
  files: { path: string; content: string }[];
}

/**
 * The outcome of committing files to a new branch on a person's behalf.
 *
 *   unauthorized  401 - the sign-in was revoked or replaced.
 *   forbidden     403/404 - the person lacks write access.
 *   branch_exists 422 on the ref - `newBranch` was taken (a lost race).
 *   base_missing  `fromBranch` does not exist.
 */
export type GitHubCommitFilesResult =
  | { committed: true; commitSha: string }
  | {
      committed: false;
      reason:
        | 'unauthorized'
        | 'forbidden'
        | 'branch_exists'
        | 'base_missing'
        | 'base_moved';
      message: string;
    };

export interface GithubProjectPort {
  /** Provision the protected environment before its first workflow runs. */
  ensureDeploymentEnvironment(input: {
    userId: string;
    repoFullName: string;
    environmentName: string;
    sourceBranch: string;
  }): Promise<void>;

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
  /**
   * Protection facts for one branch. `null` means "could not determine"
   * (never a guess); a confirmed 404 is an unprotected branch.
   */
  getBranchProtectionSummary(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GithubBranchProtectionSummary | null>;
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
  /**
   * Require a pull request on `branch` (zero approvals), block force pushes
   * and deletion, and KEEP whatever required status checks, restrictions and
   * stricter settings the branch already has. Never throws for a GitHub
   * refusal: the outcome says what happened so callers can report per branch.
   */
  ensurePullRequestProtection(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    options?: GithubPullRequestProtectionOptions,
  ): Promise<GithubBranchProtectionOutcome>;
  /**
   * One page of a branch's commits, newest first. A 401 from GitHub is a
   * revoked or replaced sign-in and throws UnauthorizedException with the
   * "sign in again" sentence; 404 (unknown branch or repository) returns an
   * empty page.
   */
  listCommits(
    accessToken: string,
    repoFullName: string,
    query: GitHubCommitListQuery,
  ): Promise<GitHubCommitPage>;
  /**
   * The repository Events API, conditional on `etag` when given. Pages 2-3
   * (GitHub keeps 300 events / 90 days) are only fetched when page 1 changed.
   */
  listRepositoryEvents(
    accessToken: string,
    repoFullName: string,
    options?: { etag?: string | null },
  ): Promise<GitHubRepositoryEventsResult>;
  /** Commits a push added: `before...head`, newest data GitHub still has. */
  compareCommits(
    accessToken: string,
    repoFullName: string,
    base: string,
    head: string,
    limit?: number,
  ): Promise<GitHubPushCommits | null>;
  /** Title and merge facts of one pull request; null when it is not visible. */
  getPullRequestHeadline(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestHeadline | null>;
  listBranches(
    accessToken: string,
    repoFullName: string,
  ): Promise<GitHubBranchSummary[]>;
  /**
   * Head-commit author login per branch, in ONE GraphQL request (first 100
   * refs, matching listBranches' page). A branch whose author has no GitHub
   * account maps to null. Throws on API failure; callers degrade.
   */
  listBranchHeadAuthors(
    accessToken: string,
    repoFullName: string,
  ): Promise<Map<string, string | null>>;
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
  /**
   * The newest run of ONE workflow file on a branch (GET
   * /actions/workflows/{file}/runs?branch=&per_page=1), or null when it has
   * none. Throws on API failure; callers degrade.
   */
  getLatestWorkflowFileRun(
    accessToken: string,
    repoFullName: string,
    workflowFile: string,
    branch: string,
  ): Promise<GitHubWorkflowRunSummary | null>;
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
  ): Promise<GitHubJobLogResult>;
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
  /**
   * How `head` relates to `base` (GET compare/{base}...{head}, `per_page=1`, no
   * commits or files read): `ahead` = `head` has commits `base` lacks and
   * contains `base`; `behind` = `head` is an ancestor of `base`. Null when
   * either ref does not exist or the histories are unrelated.
   */
  getBranchRelation(
    accessToken: string,
    repoFullName: string,
    base: string,
    head: string,
  ): Promise<GitHubBranchRelation | null>;
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
   * Read several paths at `ref`, in parallel. Used by the browser-test
   * status/PR flow to learn which starter files, lockfiles and package.json a
   * repository already has.
   */
  readRepoFiles(
    accessToken: string,
    repoFullName: string,
    ref: string,
    paths: readonly string[],
  ): Promise<GitHubRepoFilesResult>;
  /**
   * Every file path at `ref`, in one request. Used by the browser-test status
   * to find a repository's own Playwright tests, whatever they are named.
   */
  listRepoPaths(
    accessToken: string,
    repoFullName: string,
    ref: string,
  ): Promise<GitHubRepoPathsResult>;
  /**
   * Commit `files` to a NEW branch in one commit through the Git Data API
   * (blobs, tree, commit, then the ref), attributed to the token's owner.
   */
  commitFilesToNewBranch(
    accessToken: string,
    repoFullName: string,
    input: GitHubCommitFilesInput,
  ): Promise<GitHubCommitFilesResult>;
  /** The commit a branch points at now; null when the branch does not exist. */
  getBranchHeadSha(
    accessToken: string,
    repoFullName: string,
    branch: string,
  ): Promise<string | null>;
  /**
   * What the caller may do on the repository, as GitHub reports it to them.
   * Null when the repository is not visible to them or GitHub will not say:
   * the answer fails closed.
   */
  getRepoPermissions(
    accessToken: string,
    repoFullName: string,
  ): Promise<GitHubRepoPermissions | null>;
  /**
   * An installation token for the App's installation on `repoFullName`, asked
   * of GitHub itself and narrowed to that one repository and `permissions`.
   * Null when the App is not installed there.
   */
  getRepoInstallationAccessToken(
    repoFullName: string,
    permissions: GitHubTokenPermissions,
  ): Promise<string | null>;
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

export interface GithubBranchProtectionSummary {
  /** False only for a confirmed 404 (no protection rule at all). */
  protected: boolean;
  pullRequestRequired: boolean;
  allowForcePushes: boolean;
  allowDeletions: boolean;
}

export interface GithubPullRequestProtectionOptions {
  /**
   * Status check contexts to add when the branch has no required checks of
   * its own. Existing required checks are always kept; this only seeds them.
   * Provisioning passes the env-guard context; retrofitting an older
   * repository passes nothing, because that repository may not have the
   * env-guard workflow and a required check that never reports blocks every
   * merge.
   */
  seedStatusChecks?: readonly string[];
}

/**
 * What happened to one branch.
 *
 *   applied    protection was created or tightened
 *   unchanged  it already required a pull request and blocked force/deletion
 *   missing    the branch does not exist in the repository
 *   failed     GitHub refused or could not be reached; `error` says why
 *              (403/404 usually means the token lacks Administration: write)
 */
export type GithubBranchProtectionStatus =
  | 'applied'
  | 'unchanged'
  | 'missing'
  | 'failed';

export interface GithubBranchProtectionOutcome {
  status: GithubBranchProtectionStatus;
  error?: string;
}

export interface GitHubCommitListQuery {
  branch: string;
  perPage: number;
  /** 1-based GitHub page. */
  page: number;
}

export interface GitHubCommitSummary {
  sha: string;
  /** Full commit message; callers take the first line. */
  message: string;
  authorLogin: string | null;
  authorName: string;
  authoredAt: string;
  url: string;
}

export interface GitHubCommitPage {
  items: GitHubCommitSummary[];
  hasNextPage: boolean;
}

/** One event of the repository Events API, as GitHub returns it. */
export interface GitHubRepositoryEvent {
  id: string;
  type: string;
  actor: { login: string } | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

export type GitHubRepositoryEventsResult =
  | { status: 'not_modified' }
  | {
      status: 'modified';
      events: GitHubRepositoryEvent[];
      etag: string | null;
    };

export interface GitHubPushCommits {
  /** GitHub's own word for how head relates to base: ahead, behind, diverged, identical. */
  status: string;
  totalCommits: number;
  commits: Array<{ sha: string; message: string; authorName: string }>;
}

export interface GitHubPullRequestHeadline {
  title: string;
  merged: boolean;
  mergedByLogin: string | null;
  htmlUrl: string;
}

export const GITHUB_PROJECT_PORT = Symbol('GithubProjectPort');
export const GITHUB_ORGANIZATION_PORT = Symbol('GithubOrganizationPort');
